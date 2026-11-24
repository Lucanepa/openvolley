//! USB stick copies of the match backups (phase 1: find the sticks, copy a
//! backup file to them on the scorer's "Copy to stick now").
//!
//! The app's own backups stay in <data dir>/OpenVolley/backups (backup.rs).
//! A stick gets copies of those files, in the app's own folder:
//!
//!   <stick>/OpenVolley/<match dir>/<device tag>-latest.json
//!   <stick>/OpenVolley/<match dir>/<device tag>-manual-<yyyymmddThhmmss>Z.json
//!   <stick>/OpenVolley/README.txt
//!
//! (OpenBeach: `OpenBeach/`, the flavour's data folder, owner 2026-11-12.)
//! The files are the same bytes as the app's backup files: encrypted with the
//! match's game PIN and referee PIN (utils/backupCrypto), a test match plain
//! (owner 2026-10-29). Several computers can write to one stick: each file
//! name starts with the computer's own tag (src/utils/stickBackup).
//!
//! Stick-agnostic (owner 2026-10-29: "find any removable stick, create the
//! folder if missing, no remembered path"): every listing looks again at
//! what is mounted, and a copy goes to every stick present. The page never
//! sends or sees a path: a stick is an opaque id (a hash of its mount point
//! and volume serial) the last listing handed out, and the file names are
//! checked like backup.rs's, so nothing a page sends can leave the stick's
//! app folder. The ACL (build.rs + capabilities/stick.json) admits only the
//! scoretable window loaded from http://localhost.
//!
//! A copy is confirmed: enough free space (the file + 8 MiB), a temp file
//! flushed to the stick, renamed over the old one, the folder flushed, then
//! read back from the stick (past the page cache where that is cheap) and
//! compared by SHA-256, and parsed as JSON. Files on a stick are not made
//! private (FAT has no owner): the PIN encryption is what protects them.
//!
//! Finding sticks:
//! - Linux: /proc/self/mountinfo + /sys/dev/block (removable, on USB, or an
//!   SD card); without them (a sandbox) the folders mounted under
//!   /run/media/$USER, /media/$USER, /media and /mnt.
//! - Windows: removable drive letters, and fixed ones on the USB bus.
//! - macOS: /Volumes, removability from `diskutil info -plist`.
//!
//! `OPENVOLLEY_STICK_ROOTS` (a path list) replaces the detection with those
//! folders (tests).
//!
//! Later phases (not here): the automatic mirror of every backup, the set-end
//! and match-end steps, rotation when a stick runs low, restore from a stick.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, State};

/// Largest file copied or read (backup.rs MAX_BACKUP_BYTES).
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// A *-latest.json larger than this is listed without its header.
const HEADER_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// Free space kept on a stick beyond the file being written.
const FREE_MARGIN: u64 = 8 * 1024 * 1024;
const README: &str = "README.txt";

pub const ERR_REMOVED: &str = "removed";
pub const ERR_READ_ONLY: &str = "readOnly";
pub const ERR_FULL: &str = "full";
pub const ERR_LOCKED: &str = "locked";
pub const ERR_IO: &str = "io";

#[derive(Debug, Clone, PartialEq)]
pub struct StickError {
    pub code: &'static str,
    pub message: String,
}

impl StickError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    fn from_io(what: &str, e: &std::io::Error) -> Self {
        Self::new(classify_io(e), format!("{what}: {e}"))
    }
}

impl From<StickError> for String {
    fn from(e: StickError) -> String {
        format!("{}: {}", e.code, e.message)
    }
}

/// The error code of a failed file operation on a stick.
fn classify_io(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    if let Some(code) = e.raw_os_error() {
        #[cfg(unix)]
        {
            match code {
                libc::EROFS | libc::EACCES | libc::EPERM => return ERR_READ_ONLY,
                libc::ENOSPC | libc::EDQUOT => return ERR_FULL,
                libc::ENOENT | libc::ENODEV | libc::ENXIO => return ERR_REMOVED,
                _ => {}
            }
        }
        #[cfg(windows)]
        {
            // ERROR_WRITE_PROTECT, ERROR_ACCESS_DENIED; ERROR_HANDLE_DISK_FULL,
            // ERROR_DISK_FULL; ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
            // ERROR_NOT_READY, ERROR_DEV_NOT_EXIST, ERROR_DEVICE_NOT_CONNECTED
            match code {
                19 | 5 => return ERR_READ_ONLY,
                39 | 112 => return ERR_FULL,
                2 | 3 | 21 | 55 | 1167 => return ERR_REMOVED,
                _ => {}
            }
        }
    }
    match e.kind() {
        ErrorKind::PermissionDenied => ERR_READ_ONLY,
        ErrorKind::NotFound => ERR_REMOVED,
        _ => ERR_IO,
    }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// Device names Windows reserves in every folder (also as `CON.json`).
fn reserved_on_windows(s: &str) -> bool {
    let base = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

/// backup.rs's strict segment, and nothing Windows or FAT would change: no
/// trailing dot (dropped by Windows, so `game7.` would be `game7`), no
/// reserved device name. A stick moves between computers.
pub fn valid_stick_segment(s: &str) -> bool {
    crate::backup::valid_segment(s) && !s.ends_with('.') && !reserved_on_windows(s)
}

pub fn valid_stick_file(s: &str) -> bool {
    valid_stick_segment(s) && crate::backup::valid_file_name(s)
}

fn check_names(match_dir: &str, file_name: &str) -> Result<(), StickError> {
    if !valid_stick_segment(match_dir) {
        return Err(StickError::new(ERR_IO, format!("invalid backup folder name: {match_dir:?}")));
    }
    if !valid_stick_file(file_name) {
        return Err(StickError::new(ERR_IO, format!("invalid backup file name: {file_name:?}")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

/// A mounted volume that is a stick, as the detection found it.
#[derive(Debug, Clone, PartialEq)]
pub struct Volume {
    pub path: PathBuf,
    pub label: String,
    pub fs: String,
    pub read_only: bool,
    /// Present but not readable (Windows: a BitLocker drive not unlocked).
    pub locked: bool,
    /// Volume serial / uuid where the system has one ("" otherwise).
    pub serial: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StickInfo {
    pub id: String,
    pub label: String,
    pub fs: String,
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub read_only: bool,
    pub locked: bool,
    /// The stick has the app's folder already (a stick used before).
    pub has_folder: bool,
}

/// The opaque id of a stick: its mount point and volume serial, hashed.
pub fn stick_id(v: &Volume) -> String {
    let mut h = Sha256::new();
    h.update(v.path.to_string_lossy().as_bytes());
    h.update(b"\n");
    h.update(v.serial.as_bytes());
    hex(&h.finalize())[..16].to_string()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Space {
    pub free: u64,
    pub total: u64,
    pub read_only: bool,
}

/// Free space for this user, the size of the volume and its read-only flag.
#[cfg(unix)]
pub fn space_of(path: &Path) -> Option<Space> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c is a NUL-terminated path, st a writable statvfs
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = if st.f_frsize > 0 { st.f_frsize as u64 } else { st.f_bsize as u64 };
    Some(Space {
        free: (st.f_bavail as u64).saturating_mul(frsize),
        total: (st.f_blocks as u64).saturating_mul(frsize),
        read_only: (st.f_flag & libc::ST_RDONLY) != 0,
    })
}

#[cfg(windows)]
pub fn space_of(path: &Path) -> Option<Space> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let (mut free, mut total) = (0u64, 0u64);
    let p = HSTRING::from(path);
    // SAFETY: two writable u64 outputs
    unsafe { GetDiskFreeSpaceExW(&p, Some(&mut free as *mut u64), Some(&mut total as *mut u64), None) }.ok()?;
    Some(Space { free, total, read_only: false })
}

#[cfg(not(any(unix, windows)))]
pub fn space_of(_path: &Path) -> Option<Space> {
    None
}

/// The folders in OPENVOLLEY_STICK_ROOTS as sticks (tests).
fn fake_volumes(list: &std::ffi::OsStr) -> Vec<Volume> {
    std::env::split_paths(list)
        .filter(|p| p.is_dir())
        .map(|path| {
            let read_only = fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false);
            Volume {
                label: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                fs: "folder".into(),
                read_only,
                locked: false,
                serial: String::new(),
                path,
            }
        })
        .collect()
}

/// The sticks present now. `excluded`: folders the app keeps its own data
/// in; a volume holding one of them is never a stick.
pub fn detect(excluded: &[PathBuf]) -> Vec<Volume> {
    if let Some(list) = std::env::var_os("OPENVOLLEY_STICK_ROOTS").filter(|l| !l.is_empty()) {
        return fake_volumes(&list);
    }
    platform_volumes(excluded)
}

#[cfg(target_os = "linux")]
fn platform_volumes(excluded: &[PathBuf]) -> Vec<Volume> {
    linux::volumes(excluded)
}

#[cfg(windows)]
fn platform_volumes(excluded: &[PathBuf]) -> Vec<Volume> {
    win::volumes(excluded)
}

#[cfg(target_os = "macos")]
fn platform_volumes(excluded: &[PathBuf]) -> Vec<Volume> {
    macos::volumes(excluded)
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn platform_volumes(_excluded: &[PathBuf]) -> Vec<Volume> {
    Vec::new()
}

fn info_of(id: String, v: &Volume, app_folder: &str) -> StickInfo {
    let space = if v.locked { None } else { space_of(&v.path) };
    StickInfo {
        id,
        label: v.label.clone(),
        fs: v.fs.clone(),
        free_bytes: space.map(|s| s.free),
        total_bytes: space.map(|s| s.total),
        read_only: v.read_only || space.map(|s| s.read_only).unwrap_or(false),
        locked: v.locked,
        has_folder: !v.locked && v.path.join(app_folder).is_dir(),
    }
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::Volume;
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    /// File systems a stick or a USB disk carries. Not tmpfs, overlay,
    /// squashfs (snaps), iso9660 (a CD), network shares.
    const STICK_FS: &[&str] = &[
        "vfat", "msdos", "exfat", "ntfs", "ntfs3", "fuseblk", "ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "hfsplus",
    ];
    const LOOP_MAJOR: u32 = 7;

    #[derive(Debug, Clone, PartialEq)]
    pub struct MountEntry {
        pub major: u32,
        pub minor: u32,
        pub mount_point: PathBuf,
        pub fs_type: String,
        pub source: String,
        pub read_only: bool,
    }

    /// A mountinfo field with its octal escapes (`\040` space, `\011` tab,
    /// `\012` newline, `\134` backslash) decoded.
    pub fn unescape(field: &str) -> Vec<u8> {
        let b = field.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
                out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
                i += 4;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        out
    }

    /// /proc/self/mountinfo:
    /// `36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw,errors=continue`
    pub fn parse_mountinfo(text: &str) -> Vec<MountEntry> {
        let mut out = Vec::new();
        for line in text.lines() {
            let fields: Vec<&str> = line.split(' ').collect();
            if fields.len() < 10 {
                continue;
            }
            let Some(sep) = fields.iter().skip(6).position(|f| *f == "-").map(|p| p + 6) else { continue };
            if fields.len() < sep + 4 {
                continue;
            }
            let Some((maj, min)) = fields[2].split_once(':') else { continue };
            let (Ok(major), Ok(minor)) = (maj.parse(), min.parse()) else { continue };
            let opts_ro = |o: &str| o.split(',').any(|x| x == "ro");
            out.push(MountEntry {
                major,
                minor,
                mount_point: PathBuf::from(OsStr::from_bytes(&unescape(fields[4]))),
                fs_type: fields[sep + 1].to_string(),
                source: String::from_utf8_lossy(&unescape(fields[sep + 2])).to_string(),
                read_only: opts_ro(fields[5]) || opts_ro(fields[sep + 3]),
            });
        }
        out
    }

    /// Whether the block device major:minor is a stick: its disk is
    /// removable, hangs off USB, or is an SD card. None when sysfs does not
    /// know the device (unreadable in a sandbox).
    pub fn is_removable_block(sys_root: &Path, major: u32, minor: u32) -> Option<bool> {
        let link = sys_root.join("dev/block").join(format!("{major}:{minor}"));
        let real = fs::canonicalize(&link).ok()?;
        let disk = if real.join("partition").exists() { real.parent()?.to_path_buf() } else { real.clone() };
        let name = disk.file_name()?.to_string_lossy().to_string();
        if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("zram") {
            return Some(false);
        }
        let read = |p: PathBuf| fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default();
        if read(disk.join("removable")) == "1" {
            return Some(true);
        }
        if real.to_string_lossy().contains("/usb") {
            return Some(true);
        }
        if name.starts_with("mmcblk") && read(disk.join("device/type")) == "SD" {
            return Some(true);
        }
        Some(false)
    }

    /// The folders a desktop mounts sticks under (the fallback without
    /// sysfs, and the guess for a device sysfs does not show).
    pub fn media_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(user) = std::env::var_os("USER").filter(|u| !u.is_empty()) {
            roots.push(Path::new("/run/media").join(&user));
            roots.push(Path::new("/media").join(&user));
        }
        roots.push(PathBuf::from("/media"));
        roots.push(PathBuf::from("/mnt"));
        roots
    }

    fn under_media(p: &Path) -> bool {
        ["/run/media/", "/media/", "/mnt/"].iter().any(|r| p.starts_with(r) && p != Path::new(r.trim_end_matches('/')))
    }

    fn system_mount(p: &Path) -> bool {
        p == Path::new("/")
            || ["/boot", "/proc", "/sys", "/dev", "/snap", "/var/lib/snapd", "/usr", "/etc"].iter().any(|r| p.starts_with(r))
    }

    /// The device numbers of a mount's source (`/dev/sdb1`): a fuseblk
    /// (ntfs-3g) or btrfs mount shows 0:N in mountinfo.
    pub fn dev_of_source(source: &str) -> Option<(u32, u32)> {
        if !source.starts_with("/dev/") {
            return None;
        }
        let rdev = fs::metadata(source).ok()?.rdev();
        Some(split_dev(rdev))
    }

    /// glibc's major()/minor() of a dev_t.
    pub fn split_dev(dev: u64) -> (u32, u32) {
        let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
        let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
        (major as u32, minor as u32)
    }

    /// The mounts that are sticks (pure over its inputs: tests pass a
    /// fixture sysfs root and source lookup).
    pub fn stick_mounts(
        mounts: &[MountEntry],
        sys_root: &Path,
        excluded: &[PathBuf],
        source_dev: &dyn Fn(&str) -> Option<(u32, u32)>,
    ) -> Vec<MountEntry> {
        let mut out: Vec<(MountEntry, Option<(u32, u32)>)> = Vec::new();
        for m in mounts {
            if !STICK_FS.contains(&m.fs_type.as_str()) || system_mount(&m.mount_point) {
                continue;
            }
            if excluded.iter().any(|x| x.starts_with(&m.mount_point)) {
                continue;
            }
            let dev = if m.major == 0 { source_dev(&m.source) } else { Some((m.major, m.minor)) };
            let removable = match dev {
                Some((LOOP_MAJOR, _)) => Some(false),
                Some((maj, min)) => is_removable_block(sys_root, maj, min),
                None => None,
            };
            // sysfs does not know it (a sandbox): a mount under the media folders
            if !removable.unwrap_or_else(|| under_media(&m.mount_point)) {
                continue;
            }
            // one device mounted twice (a bind mount): its first mount only
            if dev.is_some() && out.iter().any(|(_, od)| *od == dev) {
                continue;
            }
            out.push((m.clone(), dev));
        }
        out.into_iter().map(|(m, _)| m).collect()
    }

    /// Without mountinfo: the folders under the media roots that are their
    /// own file system (another device than their parent).
    pub fn fallback_mounts(roots: &[PathBuf], excluded: &[PathBuf]) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for root in roots {
            let Ok(parent) = fs::metadata(root) else { continue };
            let Ok(entries) = fs::read_dir(root) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                let Ok(meta) = fs::metadata(&p) else { continue };
                if !meta.is_dir() || meta.dev() == parent.dev() || out.contains(&p) {
                    continue;
                }
                if excluded.iter().any(|x| x.starts_with(&p)) {
                    continue;
                }
                out.push(p);
            }
        }
        out
    }

    /// The uuid udev links to a device (`/dev/disk/by-uuid/<uuid>`).
    fn uuid_of(source: &str) -> String {
        let Ok(target) = fs::canonicalize(source) else { return String::new() };
        let Ok(entries) = fs::read_dir("/dev/disk/by-uuid") else { return String::new() };
        for e in entries.flatten() {
            if fs::canonicalize(e.path()).ok().as_ref() == Some(&target) {
                return e.file_name().to_string_lossy().to_string();
            }
        }
        String::new()
    }

    fn label_of(p: &Path) -> String {
        p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
    }

    pub fn volumes(excluded: &[PathBuf]) -> Vec<Volume> {
        match fs::read_to_string("/proc/self/mountinfo") {
            Ok(text) => {
                let mounts = parse_mountinfo(&text);
                stick_mounts(&mounts, Path::new("/sys"), excluded, &dev_of_source)
                    .into_iter()
                    .map(|m| Volume {
                        label: label_of(&m.mount_point),
                        serial: uuid_of(&m.source),
                        path: m.mount_point,
                        fs: m.fs_type,
                        read_only: m.read_only,
                        locked: false,
                    })
                    .collect()
            }
            Err(_) => fallback_mounts(&media_roots(), excluded)
                .into_iter()
                .map(|p| Volume { label: label_of(&p), path: p, fs: String::new(), read_only: false, locked: false, serial: String::new() })
                .collect(),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const MOUNTINFO: &str = "\
22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
25 22 259:1 / /boot/efi rw,relatime shared:3 - vfat /dev/nvme0n1p1 rw,fmask=0077,dmask=0077
26 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
40 22 7:0 / /snap/core22/1380 ro,nodev,relatime shared:20 - squashfs /dev/loop0 ro
41 22 7:1 / /data/openvolley/pg rw,relatime shared:21 - ext4 /dev/loop1 rw
50 22 8:17 / /run/media/scorer/MY\\040STICK rw,nosuid,nodev,relatime shared:30 - vfat /dev/sdb1 rw,fmask=0022,uid=1000
51 22 0:57 / /run/media/scorer/WINDISK rw,nosuid,nodev,relatime shared:31 - fuseblk /dev/sdc1 rw,user_id=0,allow_other
52 22 179:1 / /media/scorer/SDCARD ro,nosuid,nodev shared:32 - exfat /dev/mmcblk0p1 rw
53 22 8:1 / /home rw,relatime shared:33 - ext4 /dev/sda1 rw
54 22 8:33 / /mnt/backupdisk rw,relatime shared:34 - ext4 /dev/sdd1 rw
55 22 8:17 / /var/run/flatpak-bind rw,relatime shared:35 - vfat /dev/sdb1 rw
";

        #[test]
        fn mountinfo_fields_and_escapes() {
            let m = parse_mountinfo(MOUNTINFO);
            assert_eq!(m.len(), 11);
            let stick = &m[5];
            assert_eq!(stick.mount_point, PathBuf::from("/run/media/scorer/MY STICK"));
            assert_eq!((stick.major, stick.minor), (8, 17));
            assert_eq!(stick.fs_type, "vfat");
            assert_eq!(stick.source, "/dev/sdb1");
            assert!(!stick.read_only);
            assert!(m[7].read_only, "ro in the mount options");
            assert!(m[3].read_only, "ro squashfs");
            assert_eq!(unescape("a\\011b\\134c\\012"), b"a\tb\\c\n");
            assert_eq!(unescape("trailing\\04"), b"trailing\\04", "a cut escape stays as it is");
            assert!(parse_mountinfo("garbage line\n\n1 2 x / / rw - ext4").is_empty());
        }

        /// A fixture /sys: dev/block/M:m links into devices/..., like the kernel's.
        fn fake_sys(tag: &str) -> PathBuf {
            let root = std::env::temp_dir().join(format!("ov-stick-sys-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let disk = |path: &str, removable: &str| {
                let d = root.join(path);
                fs::create_dir_all(&d).unwrap();
                fs::write(d.join("removable"), removable).unwrap();
                d
            };
            let part = |disk: &Path, name: &str, devno: &str| {
                let p = disk.join(name);
                fs::create_dir_all(&p).unwrap();
                fs::write(p.join("partition"), "1").unwrap();
                fs::create_dir_all(root.join("dev/block")).unwrap();
                std::os::unix::fs::symlink(&p, root.join("dev/block").join(devno)).unwrap();
            };
            let nvme = disk("devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1", "0");
            part(&nvme, "nvme0n1p1", "259:1");
            part(&nvme, "nvme0n1p2", "259:2");
            // a stick that says removable=1
            let sdb = disk("devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb", "1");
            part(&sdb, "sdb1", "8:17");
            // a USB disk that says removable=0: on USB all the same
            let sdc = disk("devices/pci0000:00/0000:00:14.0/usb3/3-2/3-2:1.0/host7/target7:0:0/7:0:0:0/block/sdc", "0");
            part(&sdc, "sdc1", "8:33");
            // an SD card reader
            let mmc = disk("devices/platform/mmc0/mmc0:0001/block/mmcblk0", "0");
            fs::create_dir_all(mmc.join("device")).unwrap();
            fs::write(mmc.join("device/type"), "SD").unwrap();
            part(&mmc, "mmcblk0p1", "179:1");
            // the internal SATA disk
            let sda = disk("devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda", "0");
            part(&sda, "sda1", "8:1");
            root
        }

        #[test]
        fn sysfs_tells_sticks_from_internal_disks() {
            let sys = fake_sys("block");
            assert_eq!(is_removable_block(&sys, 8, 17), Some(true), "removable=1");
            assert_eq!(is_removable_block(&sys, 8, 33), Some(true), "on USB");
            assert_eq!(is_removable_block(&sys, 179, 1), Some(true), "SD card");
            assert_eq!(is_removable_block(&sys, 8, 1), Some(false), "SATA disk");
            assert_eq!(is_removable_block(&sys, 259, 2), Some(false), "NVMe");
            assert_eq!(is_removable_block(&sys, 9, 9), None, "unknown to sysfs");
            let _ = fs::remove_dir_all(&sys);
        }

        #[test]
        fn only_sticks_are_listed() {
            let sys = fake_sys("mounts");
            let mounts = parse_mountinfo(MOUNTINFO);
            // ntfs-3g shows 0:57; its source /dev/sdc1 is the USB disk 8:33
            let source = |s: &str| (s == "/dev/sdc1").then_some((8, 33));
            let found = stick_mounts(&mounts, &sys, &[], &source);
            let paths: Vec<_> = found.iter().map(|m| m.mount_point.to_string_lossy().to_string()).collect();
            // not /, /boot/efi (vfat, internal), /proc, snaps, loop images,
            // the internal /home; the stick's bind mount only once; /mnt/backupdisk
            // (8:33) is the same USB disk as WINDISK
            assert_eq!(paths, ["/run/media/scorer/MY STICK", "/run/media/scorer/WINDISK", "/media/scorer/SDCARD"]);
            assert!(found[2].read_only);

            // a mount holding the app's data is never a stick
            let excluded = [PathBuf::from("/run/media/scorer/MY STICK/home/.local/share/OpenVolley/backups")];
            let found = stick_mounts(&mounts, &sys, &excluded, &source);
            assert!(found.iter().all(|m| m.mount_point != Path::new("/run/media/scorer/MY STICK")));
            let _ = fs::remove_dir_all(&sys);
        }

        #[test]
        fn without_sysfs_the_media_folders_count() {
            let missing = std::env::temp_dir().join("ov-stick-no-sys");
            let mounts = parse_mountinfo(MOUNTINFO);
            let found = stick_mounts(&mounts, &missing, &[], &|_| None);
            let paths: Vec<_> = found.iter().map(|m| m.mount_point.to_string_lossy().to_string()).collect();
            assert!(paths.contains(&"/run/media/scorer/MY STICK".to_string()));
            assert!(paths.contains(&"/mnt/backupdisk".to_string()));
            assert!(!paths.iter().any(|p| p == "/" || p.starts_with("/boot") || p == "/home" || p.starts_with("/var")), "{paths:?}");
        }

        #[test]
        fn fallback_lists_only_other_file_systems() {
            // a plain folder under a media root is the same device: not a stick
            let root = std::env::temp_dir().join(format!("ov-stick-media-{}", std::process::id()));
            fs::create_dir_all(root.join("NOTASTICK")).unwrap();
            assert!(fallback_mounts(&[root.clone()], &[]).is_empty());
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn dev_numbers_split_like_glibc() {
            assert_eq!(split_dev(0x811), (8, 17));
            assert_eq!(split_dev((259 << 8) | 2), (259, 2));
            // a large minor (dev_t's high bits)
            assert_eq!(split_dev((1u64 << 20) | (8 << 8) | 1), (8, 257));
        }

        /// This machine, for real: whatever it mounts, its root, /boot and
        /// loop images are never listed.
        #[test]
        fn this_machine_lists_no_system_volume() {
            for v in volumes(&[]) {
                let p = v.path.to_string_lossy().to_string();
                assert!(p != "/" && !p.starts_with("/boot") && !p.starts_with("/snap"), "{p}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/// What `diskutil info -plist <mount>` says about a volume.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
pub struct DiskutilInfo {
    pub removable: bool,
    pub uuid: String,
    pub name: String,
}

/// A stick, a card or a USB disk: not internal, removable, ejectable or on
/// USB. Never a mounted disk image (a .dmg).
#[cfg(any(target_os = "macos", test))]
pub fn parse_diskutil_plist(bytes: &[u8]) -> Option<DiskutilInfo> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes)).ok()?;
    let dict = value.as_dictionary()?;
    let flag = |k: &str| dict.get(k).and_then(|v| v.as_boolean());
    let text = |k: &str| dict.get(k).and_then(|v| v.as_string()).unwrap_or("").to_string();
    let bus = text("BusProtocol");
    let removable = bus != "Disk Image"
        && (flag("Internal") == Some(false)
            || flag("RemovableMedia") == Some(true)
            || flag("RemovableMediaOrExternalDevice") == Some(true)
            || flag("Ejectable") == Some(true)
            || bus == "USB");
    let uuid = [text("VolumeUUID"), text("DiskUUID")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
    Some(DiskutilInfo { removable, uuid, name: text("VolumeName") })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{parse_diskutil_plist, DiskutilInfo, Volume};
    use std::collections::HashMap;
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    const DISKUTIL_TIMEOUT: Duration = Duration::from_secs(3);
    const STICK_FS: &[&str] = &["msdos", "exfat", "hfs", "apfs", "ntfs", "ufs"];

    /// diskutil's answer per mount (path + fsid): one run per stick, not per poll.
    fn cache() -> &'static Mutex<HashMap<String, DiskutilInfo>> {
        static CACHE: OnceLock<Mutex<HashMap<String, DiskutilInfo>>> = OnceLock::new();
        CACHE.get_or_init(Default::default)
    }

    /// `diskutil info -plist <mount>`, given up after 3 s (a stick that
    /// hangs must not hold the listing).
    fn diskutil(mount: &Path) -> Option<DiskutilInfo> {
        let mut child = Command::new("/usr/sbin/diskutil")
            .args(["info", "-plist"])
            .arg(mount)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return None,
                Ok(None) if start.elapsed() < DISKUTIL_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut child.stdout.take()?, &mut out).ok()?;
        parse_diskutil_plist(&out)
    }

    fn cstr_field(buf: &[libc::c_char]) -> String {
        // SAFETY: statfs fills NUL-terminated names within the buffer
        unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().to_string()
    }

    pub fn volumes(excluded: &[PathBuf]) -> Vec<Volume> {
        let mut out = Vec::new();
        let root_dev = std::fs::metadata("/").map(|m| m.dev()).ok();
        let Ok(entries) = std::fs::read_dir("/Volumes") else { return out };
        for e in entries.flatten() {
            let path = e.path();
            // the boot volume's link to /
            if e.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            if Some(meta.dev()) == root_dev || excluded.iter().any(|x| x.starts_with(&path)) {
                continue;
            }
            let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { continue };
            let mut st: libc::statfs = unsafe { std::mem::zeroed() };
            // SAFETY: c is a NUL-terminated path, st a writable statfs
            if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
                continue;
            }
            let flags = st.f_flags as i64;
            if flags & libc::MNT_DONTBROWSE as i64 != 0 {
                continue;
            }
            // a plain folder in /Volumes is not a mount point
            if Path::new(&cstr_field(&st.f_mntonname)) != path {
                continue;
            }
            let fs = cstr_field(&st.f_fstypename);
            if !STICK_FS.contains(&fs.as_str()) {
                continue;
            }
            let key = format!("{}\n{}", path.display(), meta.dev());
            let cached = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
            let info = match cached {
                Some(i) => i,
                None => {
                    // not cached on a timeout: the next listing asks again
                    let Some(i) = diskutil(&path) else { continue };
                    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key, i.clone());
                    i
                }
            };
            if !info.removable {
                continue;
            }
            out.push(Volume {
                label: if info.name.is_empty() { e.file_name().to_string_lossy().to_string() } else { info.name.clone() },
                fs,
                read_only: flags & libc::MNT_RDONLY as i64 != 0,
                locked: false,
                serial: info.uuid.clone(),
                path,
            });
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::Volume;
    use std::path::{Path, PathBuf};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        BusTypeUsb, CreateFileW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW, FILE_FLAGS_AND_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS, THREAD_ERROR_MODE};
    use windows::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DEVICE_DESCRIPTOR,
        STORAGE_PROPERTY_QUERY,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const FILE_READ_ONLY_VOLUME: u32 = 0x0008_0000;

    /// No "There is no disk in the drive" box while drives are probed;
    /// the thread's old mode comes back on drop.
    struct QuietErrors(THREAD_ERROR_MODE);
    impl QuietErrors {
        fn new() -> Self {
            let mut old = THREAD_ERROR_MODE(0);
            // SAFETY: a writable old-mode output
            let _ = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, Some(&mut old as *mut THREAD_ERROR_MODE)) };
            Self(old)
        }
    }
    impl Drop for QuietErrors {
        fn drop(&mut self) {
            // SAFETY: restores the mode read in new()
            let _ = unsafe { SetThreadErrorMode(self.0, None) };
        }
    }

    /// A fixed drive (a USB hard disk or a "fixed" stick) on the USB bus.
    fn on_usb(letter: char) -> bool {
        let device = HSTRING::from(format!("\\\\.\\{letter}:"));
        // access 0: the device's properties only, no admin rights needed
        // SAFETY: plain handle creation, closed below
        let Ok(handle) = (unsafe {
            CreateFileW(&device, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None)
        }) else {
            return false;
        };
        let query = STORAGE_PROPERTY_QUERY {
            PropertyId: StorageDeviceProperty,
            QueryType: PropertyStandardQuery,
            ..Default::default()
        };
        // u64s: the descriptor's alignment
        let mut buf = [0u64; 128];
        let mut returned = 0u32;
        // SAFETY: input and output buffers of the given sizes
        let ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                Some(&query as *const _ as *const core::ffi::c_void),
                std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                std::mem::size_of_val(&buf) as u32,
                Some(&mut returned as *mut u32),
                None,
            )
        }
        .is_ok();
        // SAFETY: the handle from CreateFileW above
        let _ = unsafe { CloseHandle(handle) };
        if !ok || (returned as usize) < std::mem::size_of::<STORAGE_DEVICE_DESCRIPTOR>() {
            return false;
        }
        // SAFETY: the buffer holds at least one descriptor
        let desc = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const STORAGE_DEVICE_DESCRIPTOR) };
        desc.BusType == BusTypeUsb
    }

    fn drive_of(p: &Path) -> Option<char> {
        let s = p.to_string_lossy();
        let mut c = s.chars();
        let letter = c.next()?.to_ascii_uppercase();
        (letter.is_ascii_alphabetic() && c.next() == Some(':')).then_some(letter)
    }

    pub fn volumes(excluded: &[PathBuf]) -> Vec<Volume> {
        let _quiet = QuietErrors::new();
        let mut skip: Vec<char> = excluded.iter().filter_map(|p| drive_of(p)).collect();
        for var in ["SystemDrive", "APPDATA", "LOCALAPPDATA"] {
            if let Some(d) = std::env::var_os(var).and_then(|v| drive_of(Path::new(&v))) {
                skip.push(d);
            }
        }
        // SAFETY: no arguments
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            if skip.contains(&letter) {
                continue;
            }
            let root = format!("{letter}:\\");
            let wroot = HSTRING::from(root.as_str());
            // SAFETY: a NUL-terminated root path
            let kind = unsafe { GetDriveTypeW(&wroot) };
            if !(kind == DRIVE_REMOVABLE || (kind == DRIVE_FIXED && on_usb(letter))) {
                continue;
            }
            let mut name = [0u16; 261];
            let mut fs = [0u16; 261];
            let (mut serial, mut flags) = (0u32, 0u32);
            // SAFETY: writable buffers and outputs
            let read = unsafe {
                GetVolumeInformationW(&wroot, Some(&mut name[..]), Some(&mut serial as *mut u32), None, Some(&mut flags as *mut u32), Some(&mut fs[..]))
            };
            let text = |b: &[u16]| String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]);
            let (label, fs_name, locked) = match read {
                Ok(()) => (text(&name), text(&fs), false),
                // an empty card reader slot has no volume; a BitLocker drive not
                // unlocked answers too, but not with a file system
                Err(_) if kind == DRIVE_REMOVABLE && !Path::new(&root).exists() => continue,
                Err(_) => (String::new(), String::new(), true),
            };
            out.push(Volume {
                label: if label.is_empty() { format!("{letter}:") } else { format!("{label} ({letter}:)") },
                fs: fs_name,
                read_only: flags & FILE_READ_ONLY_VOLUME != 0,
                locked,
                serial: if locked { String::new() } else { format!("{serial:08X}") },
                path: PathBuf::from(root),
            });
        }
        out
    }
}

// ---------------------------------------------------------------------------
// The confirmed copy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub sha256: String,
    pub bytes: u64,
    pub verified: bool,
    /// ms since the epoch
    pub at: u64,
}

fn readme_text() -> String {
    let app = crate::flavour::CURRENT.name;
    [
        format!("{app} match backups"),
        String::new(),
        format!("This folder holds copies of the match backups {app} saves on the scoring computer."),
        "Each match has its own folder. Every file is the whole match at one moment;".into(),
        "<computer>-latest.json is the newest, the other files are earlier copies.".into(),
        "Several computers can use one stick: each file name starts with its computer's tag.".into(),
        String::new(),
        "The files of a match with a game PIN or a referee PIN are encrypted. To restore one,".into(),
        format!("open {app}, Options, \"Restore from a backup file\", pick the file and enter the"),
        "game PIN or the referee PIN of the match. Test matches are not encrypted.".into(),
        String::new(),
        "Do not rename or edit the files.".into(),
        String::new(),
    ]
    .join("\r\n")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Flushes a file to the device: fsync, on macOS F_FULLFSYNC (fsync there
/// leaves the data in the drive's cache).
fn sync_file(f: &fs::File) -> std::io::Result<()> {
    f.sync_all()?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: a valid open descriptor
        unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) };
    }
    Ok(())
}

/// The file's pages out of the page cache, so the read back comes from the
/// stick (Linux; macOS reads with F_NOCACHE; elsewhere nothing cheap).
#[allow(unused_variables)]
fn drop_cache(f: &fs::File) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: a valid open descriptor; advice only
        unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    }
}

#[allow(unused_variables)]
fn open_uncached(path: &Path) -> std::io::Result<fs::File> {
    let f = fs::File::open(path)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: a valid open descriptor
        unsafe { libc::fcntl(f.as_raw_fd(), libc::F_NOCACHE, 1) };
    }
    Ok(f)
}

/// Rename over an existing file. Windows: MoveFileExW with WRITE_THROUGH,
/// so the rename itself is on the stick when it returns.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let (f, t) = (HSTRING::from(from), HSTRING::from(to));
        // SAFETY: two NUL-terminated paths
        unsafe { MoveFileExW(&f, &t, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }
            .map_err(|e| std::io::Error::from_raw_os_error((e.code().0 & 0xffff) as i32))
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Writes one file to a stick and confirms it. `free`: the stick's free
/// bytes (None: unknown, then the write itself tells).
pub fn write_confirmed(
    stick_root: &Path,
    app_folder: &str,
    match_dir: &str,
    file_name: &str,
    contents: &[u8],
    verify: bool,
    free: Option<u64>,
) -> Result<Written, StickError> {
    check_names(match_dir, file_name)?;
    if contents.len() as u64 > MAX_FILE_BYTES {
        return Err(StickError::new(ERR_IO, "backup too large"));
    }
    if !stick_root.is_dir() {
        return Err(StickError::new(ERR_REMOVED, format!("{} is gone", stick_root.display())));
    }
    if let Some(free) = free {
        if free < contents.len() as u64 + FREE_MARGIN {
            return Err(StickError::new(ERR_FULL, format!("{free} bytes free")));
        }
    }
    let app_dir = stick_root.join(app_folder);
    let dir = app_dir.join(match_dir);
    // plain folders: FAT has no owner (backup.rs's create_private_dir is for the app's own folder)
    fs::create_dir_all(&dir).map_err(|e| StickError::from_io("cannot create the folder", &e))?;
    let readme = app_dir.join(README);
    if !readme.exists() {
        let _ = fs::write(&readme, readme_text());
    }

    let tmp = dir.join(format!(".{file_name}.tmp"));
    let dest = dir.join(file_name);
    let _ = fs::remove_file(&tmp); // left by a copy the stick was pulled out during
    let written = (|| {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        f.write_all(contents)?;
        sync_file(&f)?;
        drop_cache(&f);
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(StickError::from_io("cannot write", &e));
    }
    if let Err(e) = replace_file(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(StickError::from_io("cannot rename", &e));
    }
    sync_dir(&dir);

    let sha = sha256_hex(contents);
    if verify {
        check_copy(&dest, &sha, contents.len())?;
    }
    Ok(Written { sha256: sha, bytes: contents.len() as u64, verified: verify, at: now_ms() })
}

/// Reads a copy back from the stick: the same SHA-256 as what was written,
/// and JSON.
pub fn check_copy(dest: &Path, sha: &str, len: usize) -> Result<(), StickError> {
    let mut back = Vec::with_capacity(len);
    open_uncached(dest)
        .and_then(|f| f.take(MAX_FILE_BYTES + 1).read_to_end(&mut back))
        .map_err(|e| StickError::from_io("cannot read the copy back", &e))?;
    if sha256_hex(&back) != sha {
        return Err(StickError::new(ERR_IO, format!("the copy on the stick differs ({} of {len} bytes read back)", back.len())));
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(&back)
        .map_err(|e| StickError::new(ERR_IO, format!("the copy on the stick is not JSON: {e}")))?;
    Ok(())
}

/// The app's own backup file the engine wrote (immutable: an event file).
pub fn read_source(backup_root: &Path, match_dir: &str, file_name: &str) -> Result<Vec<u8>, String> {
    if !crate::backup::valid_segment(match_dir) || !crate::backup::valid_file_name(file_name) {
        return Err(format!("{ERR_IO}: invalid backup name {match_dir:?}/{file_name:?}"));
    }
    let path = backup_root.join(match_dir).join(file_name);
    let f = fs::File::open(&path).map_err(|e| format!("{ERR_IO}: cannot read the backup {match_dir}/{file_name}: {e}"))?;
    let mut out = Vec::new();
    f.take(MAX_FILE_BYTES + 1).read_to_end(&mut out).map_err(|e| format!("{ERR_IO}: {e}"))?;
    if out.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{ERR_IO}: backup too large"));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Backups on a stick (restore comes in a later phase)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeader {
    pub format: Option<String>,
    pub format_version: Option<u64>,
    pub encrypted: bool,
    /// The envelope's clear part (game number, teams, date, set scores).
    pub readable: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StickBackupFile {
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<BackupHeader>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StickBackupDir {
    pub dir: String,
    pub files: Vec<StickBackupFile>,
}

pub fn header_of(bytes: &[u8]) -> Option<BackupHeader> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let format = v.get("format").and_then(|f| f.as_str()).map(str::to_string);
    let encrypted = format.as_deref() == Some("openvolley-encrypted-backup");
    Some(BackupHeader {
        format_version: v.get("formatVersion").and_then(|f| f.as_u64()),
        readable: if encrypted { v.get("readable").filter(|r| r.is_object()).cloned() } else { None },
        format,
        encrypted,
    })
}

pub fn list_stick_backups(stick_root: &Path, app_folder: &str) -> Result<Vec<StickBackupDir>, StickError> {
    let app_dir = stick_root.join(app_folder);
    let mut out = Vec::new();
    let entries = match fs::read_dir(&app_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && stick_root.is_dir() => return Ok(out),
        Err(e) => return Err(StickError::from_io("cannot list the stick", &e)),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_stick_segment(&name) || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut files = Vec::new();
        if let Ok(inner) = fs::read_dir(entry.path()) {
            for f in inner.flatten() {
                let fname = f.file_name().to_string_lossy().to_string();
                let Ok(meta) = f.metadata() else { continue };
                if !meta.is_file() || !valid_stick_file(&fname) {
                    continue;
                }
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let header = (fname.ends_with("latest.json") && meta.len() <= HEADER_MAX_BYTES)
                    .then(|| fs::read(f.path()).ok())
                    .flatten()
                    .and_then(|b| header_of(&b));
                files.push(StickBackupFile { name: fname, size: meta.len(), modified_ms, header });
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        out.push(StickBackupDir { dir: name, files });
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    Ok(out)
}

pub fn read_stick_file(stick_root: &Path, app_folder: &str, match_dir: &str, file_name: &str) -> Result<String, StickError> {
    check_names(match_dir, file_name)?;
    let path = stick_root.join(app_folder).join(match_dir).join(file_name);
    let f = fs::File::open(&path).map_err(|e| StickError::from_io("cannot read", &e))?;
    let mut out = Vec::new();
    f.take(MAX_FILE_BYTES + 1).read_to_end(&mut out).map_err(|e| StickError::from_io("cannot read", &e))?;
    if out.len() as u64 > MAX_FILE_BYTES {
        return Err(StickError::new(ERR_IO, "file too large for a backup"));
    }
    String::from_utf8(out).map_err(|_| StickError::new(ERR_IO, "not a backup file"))
}

pub fn remove_stick_files(stick_root: &Path, app_folder: &str, match_dir: &str, file_names: &[String]) -> Result<u32, StickError> {
    let mut removed = 0;
    for name in file_names {
        check_names(match_dir, name)?;
        match fs::remove_file(stick_root.join(app_folder).join(match_dir).join(name)) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(StickError::from_io(&format!("cannot delete {name}"), &e)),
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// State and commands
// ---------------------------------------------------------------------------

/// The sticks of the last listing (id -> volume) and one write lock per stick.
#[derive(Clone, Default)]
pub struct Sticks {
    inner: Arc<SticksInner>,
}

#[derive(Default)]
struct SticksInner {
    known: Mutex<HashMap<String, Volume>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Sticks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Looks again at what is mounted; the ids of the sticks present now.
    fn refresh(&self, excluded: &[PathBuf]) -> Vec<(String, Volume)> {
        let found: Vec<(String, Volume)> = detect(excluded).into_iter().map(|v| (stick_id(&v), v)).collect();
        let mut known = self.inner.known.lock().unwrap_or_else(|e| e.into_inner());
        *known = found.iter().cloned().collect();
        found
    }

    /// The stick with this id, if it is still there.
    fn find(&self, excluded: &[PathBuf], id: &str) -> Result<Volume, StickError> {
        self.refresh(excluded)
            .into_iter()
            .find(|(i, _)| i == id)
            .map(|(_, v)| v)
            .ok_or_else(|| StickError::new(ERR_REMOVED, "the stick is not there any more"))
    }

    fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.inner.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(id.to_string()).or_default().clone()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorResult {
    pub id: String,
    pub label: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Copies to each stick, every stick at the same time (a slow one does not
/// hold the others), each under its own lock.
fn mirror(
    sticks: &Sticks,
    targets: Vec<(String, Volume)>,
    match_dir: &str,
    dest_file: &str,
    contents: &[u8],
    verify: bool,
) -> Vec<MirrorResult> {
    let app_folder = crate::flavour::CURRENT.data_folder;
    std::thread::scope(|s| {
        let handles: Vec<_> = targets
            .into_iter()
            .map(|(id, v)| {
                let lock = sticks.lock_for(&id);
                s.spawn(move || {
                    let result = if v.locked {
                        Err(StickError::new(ERR_LOCKED, "the drive is locked"))
                    } else if v.read_only {
                        Err(StickError::new(ERR_READ_ONLY, "the stick is read-only"))
                    } else {
                        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                        let free = space_of(&v.path).map(|s| s.free);
                        write_confirmed(&v.path, app_folder, match_dir, dest_file, contents, verify, free)
                    };
                    match result {
                        Ok(w) => MirrorResult {
                            id,
                            label: v.label,
                            ok: true,
                            sha256: Some(w.sha256),
                            bytes: Some(w.bytes),
                            verified: w.verified,
                            at: Some(w.at),
                            error: None,
                            message: None,
                        },
                        Err(e) => {
                            log::warn!("[stick] copy to {} failed: {} {}", v.label, e.code, e.message);
                            MirrorResult {
                                id,
                                label: v.label,
                                ok: false,
                                sha256: None,
                                bytes: None,
                                verified: false,
                                at: None,
                                error: Some(e.code),
                                message: Some(e.message),
                            }
                        }
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// The app's own folders: a volume holding one of them is never a stick.
fn excluded_dirs<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(root) = crate::backup::backup_root(app) {
        out.push(root);
    }
    if let Ok(data) = app.path().data_dir() {
        out.push(data);
    }
    out
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The sticks present now.
#[tauri::command]
pub async fn stick_list<R: Runtime>(app: AppHandle<R>, sticks: State<'_, Sticks>) -> Result<Vec<StickInfo>, String> {
    let excluded = excluded_dirs(&app);
    let sticks = sticks.inner().clone();
    blocking(move || {
        let app_folder = crate::flavour::CURRENT.data_folder;
        Ok(sticks.refresh(&excluded).into_iter().map(|(id, v)| info_of(id, &v, app_folder)).collect())
    })
    .await
}

/// Copies `<backup root>/<matchDir>/<sourceFile>` (a file the backup engine
/// wrote) to `<stick>/<app folder>/<matchDir>/<destFile>` on the given sticks
/// (all present when none are named). One result per stick.
#[tauri::command]
pub async fn stick_mirror<R: Runtime>(
    app: AppHandle<R>,
    sticks: State<'_, Sticks>,
    stick_ids: Option<Vec<String>>,
    match_dir: String,
    source_file: String,
    dest_file: String,
    verify: bool,
) -> Result<Vec<MirrorResult>, String> {
    let root = crate::backup::backup_root(&app)?;
    let excluded = excluded_dirs(&app);
    let sticks = sticks.inner().clone();
    blocking(move || {
        check_names(&match_dir, &dest_file)?;
        let contents = read_source(&root, &match_dir, &source_file)?;
        let present = sticks.refresh(&excluded);
        let mut targets = Vec::new();
        let mut missing = Vec::new();
        match stick_ids {
            None => targets = present,
            Some(ids) => {
                for id in ids {
                    match present.iter().find(|(i, _)| *i == id) {
                        Some(t) => targets.push(t.clone()),
                        None => missing.push(MirrorResult {
                            id,
                            label: String::new(),
                            ok: false,
                            sha256: None,
                            bytes: None,
                            verified: false,
                            at: None,
                            error: Some(ERR_REMOVED),
                            message: Some("the stick is not there any more".into()),
                        }),
                    }
                }
            }
        }
        let mut out = mirror(&sticks, targets, &match_dir, &dest_file, &contents, verify);
        out.extend(missing);
        Ok(out)
    })
    .await
}

/// The match folders on a stick, with the clear header of each *-latest.json.
#[tauri::command]
pub async fn stick_list_backups<R: Runtime>(
    app: AppHandle<R>,
    sticks: State<'_, Sticks>,
    stick_id: String,
) -> Result<Vec<StickBackupDir>, String> {
    let excluded = excluded_dirs(&app);
    let sticks = sticks.inner().clone();
    blocking(move || {
        let v = sticks.find(&excluded, &stick_id)?;
        Ok(list_stick_backups(&v.path, crate::flavour::CURRENT.data_folder)?)
    })
    .await
}

/// One backup file's text from a stick (a later phase restores from it).
#[tauri::command]
pub async fn stick_read<R: Runtime>(
    app: AppHandle<R>,
    sticks: State<'_, Sticks>,
    stick_id: String,
    match_dir: String,
    file_name: String,
) -> Result<String, String> {
    let excluded = excluded_dirs(&app);
    let sticks = sticks.inner().clone();
    blocking(move || {
        let v = sticks.find(&excluded, &stick_id)?;
        Ok(read_stick_file(&v.path, crate::flavour::CURRENT.data_folder, &match_dir, &file_name)?)
    })
    .await
}

/// Deletes files of one match on a stick (the rotation of a later phase
/// picks them: this computer's oldest first, never another computer's).
#[tauri::command]
pub async fn stick_remove<R: Runtime>(
    app: AppHandle<R>,
    sticks: State<'_, Sticks>,
    stick_id: String,
    match_dir: String,
    file_names: Vec<String>,
) -> Result<u32, String> {
    let excluded = excluded_dirs(&app);
    let sticks = sticks.inner().clone();
    blocking(move || {
        let v = sticks.find(&excluded, &stick_id)?;
        let lock = sticks.lock_for(&stick_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(remove_stick_files(&v.path, crate::flavour::CURRENT.data_folder, &match_dir, &file_names)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "OpenVolley";

    fn temp_stick(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ov-stick-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const DOC: &[u8] = br#"{"format":"openvolley-encrypted-backup","formatVersion":1,"readable":{"gameN":7,"sets":[]},"ciphertext":"AA=="}"#;

    #[test]
    fn names_are_strict_and_portable() {
        assert!(valid_stick_segment("game7-match_1759740000000_ab12cd"));
        assert!(valid_stick_file("a1b2c3d4-latest.json"));
        assert!(valid_stick_file("a1b2c3d4-manual-20261112T101500Z.json"));
        for bad in ["", ".", "..", "game7.", "x..", "CON", "con.json", "NUL", "com1", "LPT9.json", "a/b", "../x", ".hidden"] {
            assert!(!valid_stick_segment(bad), "{bad:?} must be refused");
        }
        assert!(valid_stick_segment("COM0") && valid_stick_segment("CONSOLE") && valid_stick_segment("LPT10"));
        assert!(!valid_stick_file("readme.txt"));
    }

    #[test]
    fn write_and_verify_roundtrip() {
        let stick = temp_stick("roundtrip");
        let w = write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, true, Some(1 << 30)).unwrap();
        assert!(w.verified);
        assert_eq!(w.bytes, DOC.len() as u64);
        assert_eq!(w.sha256, sha256_hex(DOC));
        assert_eq!(fs::read(stick.join("OpenVolley/game7-seed/a1b2c3d4-latest.json")).unwrap(), DOC);
        let readme = fs::read_to_string(stick.join("OpenVolley/README.txt")).unwrap();
        assert!(readme.contains("game PIN or the referee PIN"), "{readme}");
        // a second copy replaces the first
        let next = br#"{"a":2}"#;
        write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", next, true, None).unwrap();
        assert_eq!(fs::read(stick.join("OpenVolley/game7-seed/a1b2c3d4-latest.json")).unwrap(), next);

        let listed = list_stick_backups(&stick, APP).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].dir, "game7-seed");
        let h = listed[0].files[0].header.clone().unwrap();
        assert!(!h.encrypted, "a plain file");
        assert_eq!(read_stick_file(&stick, APP, "game7-seed", "a1b2c3d4-latest.json").unwrap(), r#"{"a":2}"#);
        assert_eq!(remove_stick_files(&stick, APP, "game7-seed", &["a1b2c3d4-latest.json".into(), "gone.json".into()]).unwrap(), 1);
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn header_shows_the_clear_part_only() {
        let h = header_of(DOC).unwrap();
        assert!(h.encrypted);
        assert_eq!(h.format_version, Some(1));
        assert_eq!(h.readable.unwrap()["gameN"], 7);
        assert!(header_of(b"not json").is_none());
    }

    #[test]
    fn a_stale_temp_file_is_replaced() {
        let stick = temp_stick("stale");
        let dir = stick.join("OpenVolley/game7-seed");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".a1b2c3d4-latest.json.tmp"), "half a fi").unwrap();
        write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, true, None).unwrap();
        assert!(!dir.join(".a1b2c3d4-latest.json.tmp").exists());
        assert_eq!(fs::read(dir.join("a1b2c3d4-latest.json")).unwrap(), DOC);
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn a_full_stick_is_refused_before_writing() {
        let stick = temp_stick("full");
        let err = write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, true, Some(FREE_MARGIN)).unwrap_err();
        assert_eq!(err.code, ERR_FULL);
        assert!(!stick.join("OpenVolley").exists(), "nothing written");
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn a_removed_stick_says_so() {
        let stick = temp_stick("removed");
        fs::remove_dir_all(&stick).unwrap();
        let err = write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, true, None).unwrap_err();
        assert_eq!(err.code, ERR_REMOVED);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_stick_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let stick = temp_stick("ro");
        fs::set_permissions(&stick, fs::Permissions::from_mode(0o555)).unwrap();
        let probe = stick.join("probe");
        if fs::write(&probe, "x").is_ok() {
            // root ignores the mode: nothing to test here
            let _ = fs::remove_file(&probe);
        } else {
            let err = write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, true, None).unwrap_err();
            assert_eq!(err.code, ERR_READ_ONLY, "{err:?}");
            assert!(fake_volumes(stick.as_os_str())[0].read_only, "listed read-only");
        }
        fs::set_permissions(&stick, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn a_copy_that_reads_back_different_fails() {
        // not JSON: the read back parses it
        let stick = temp_stick("notjson");
        let err = write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", b"{\"a\":", true, None).unwrap_err();
        assert_eq!(err.code, ERR_IO);
        assert!(err.message.contains("not JSON"), "{err:?}");
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn hash_mismatch_is_detected() {
        let stick = temp_stick("mismatch");
        write_confirmed(&stick, APP, "game7-seed", "a1b2c3d4-latest.json", DOC, false, None).unwrap();
        let path = stick.join("OpenVolley/game7-seed/a1b2c3d4-latest.json");
        let mut damaged = fs::read(&path).unwrap();
        assert!(check_copy(&path, &sha256_hex(DOC), DOC.len()).is_ok());
        damaged[10] ^= 1;
        fs::write(&path, &damaged).unwrap();
        let err = check_copy(&path, &sha256_hex(DOC), DOC.len()).unwrap_err();
        assert_eq!(err.code, ERR_IO);
        assert!(err.message.contains("differs"), "{err:?}");
        fs::write(&path, &DOC[..20]).unwrap();
        assert!(check_copy(&path, &sha256_hex(DOC), DOC.len()).is_err(), "a short copy");
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn nothing_leaves_the_stick() {
        let stick = temp_stick("escape");
        for (d, f) in [("..", "x.json"), ("ok", "../../x.json"), ("ok", "x.sh"), ("ok.", "x.json"), ("CON", "x.json"), ("ok", "x.json.")] {
            assert!(write_confirmed(&stick, APP, d, f, DOC, true, None).is_err(), "{d}/{f}");
            assert!(read_stick_file(&stick, APP, d, f).is_err(), "{d}/{f}");
            assert!(remove_stick_files(&stick, APP, d, &[f.to_string()]).is_err(), "{d}/{f}");
        }
        assert!(read_source(&stick, "..", "x.json").is_err());
        assert!(read_source(&stick, "ok", "../x.json").is_err());
        assert!(!stick.join("OpenVolley").exists() || list_stick_backups(&stick, APP).unwrap().is_empty());
        let _ = fs::remove_dir_all(&stick);
    }

    #[test]
    fn fake_roots_are_sticks_with_stable_ids() {
        let a = temp_stick("fake-a");
        let b = temp_stick("fake-b");
        let list = std::env::join_paths([&a, &b, &a.join("missing")]).unwrap();
        let vols = fake_volumes(&list);
        assert_eq!(vols.len(), 2);
        assert_eq!(stick_id(&vols[0]), stick_id(&fake_volumes(&list)[0]));
        assert_ne!(stick_id(&vols[0]), stick_id(&vols[1]));
        assert_eq!(stick_id(&vols[0]).len(), 16);
        let info = info_of(stick_id(&vols[0]), &vols[0], APP);
        assert!(!info.has_folder);
        assert!(info.free_bytes.is_some() == cfg!(any(unix, windows)));
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn mirror_writes_every_stick() {
        let a = temp_stick("mirror-a");
        let b = temp_stick("mirror-b");
        let sticks = Sticks::new();
        let targets: Vec<_> = fake_volumes(&std::env::join_paths([&a, &b]).unwrap())
            .into_iter()
            .map(|v| (stick_id(&v), v))
            .collect();
        let mut locked = targets[1].1.clone();
        locked.locked = true;
        let targets = vec![targets[0].clone(), (targets[1].0.clone(), locked)];
        let out = mirror(&sticks, targets, "game7-seed", "a1b2c3d4-latest.json", DOC, true);
        assert_eq!(out.len(), 2);
        assert!(out[0].ok && out[0].verified, "{:?}", out[0]);
        assert_eq!(out[1].error, Some(ERR_LOCKED));
        let app = crate::flavour::CURRENT.data_folder;
        assert!(a.join(app).join("game7-seed/a1b2c3d4-latest.json").is_file());
        assert!(!b.join(app).exists());
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    const DISKUTIL_USB: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>BusProtocol</key><string>USB</string>
<key>Ejectable</key><true/>
<key>Internal</key><false/>
<key>RemovableMedia</key><true/>
<key>VolumeName</key><string>KINGSTON</string>
<key>VolumeUUID</key><string>2D2F1A4C-0000-0000-0000-000000000001</string>
</dict></plist>"#;

    const DISKUTIL_INTERNAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>BusProtocol</key><string>Apple Fabric</string>
<key>Ejectable</key><false/>
<key>Internal</key><true/>
<key>RemovableMedia</key><false/>
<key>VolumeName</key><string>Data</string>
</dict></plist>"#;

    const DISKUTIL_DMG: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>BusProtocol</key><string>Disk Image</string>
<key>Ejectable</key><true/>
<key>Internal</key><false/>
<key>VolumeName</key><string>OpenVolley 3.1.2</string>
</dict></plist>"#;

    // an external SSD on Thunderbolt: not removable media, but not internal
    const DISKUTIL_EXTERNAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>BusProtocol</key><string>PCI-Express</string>
<key>Internal</key><false/>
<key>DiskUUID</key><string>ABCD</string>
</dict></plist>"#;

    #[test]
    fn diskutil_tells_sticks_from_internal_disks() {
        let usb = parse_diskutil_plist(DISKUTIL_USB.as_bytes()).unwrap();
        assert!(usb.removable);
        assert_eq!(usb.name, "KINGSTON");
        assert_eq!(usb.uuid, "2D2F1A4C-0000-0000-0000-000000000001");
        assert!(!parse_diskutil_plist(DISKUTIL_INTERNAL.as_bytes()).unwrap().removable);
        assert!(!parse_diskutil_plist(DISKUTIL_DMG.as_bytes()).unwrap().removable, "a mounted .dmg");
        let ext = parse_diskutil_plist(DISKUTIL_EXTERNAL.as_bytes()).unwrap();
        assert!(ext.removable);
        assert_eq!(ext.uuid, "ABCD");
        assert!(parse_diskutil_plist(b"not a plist").is_none());
    }

    #[test]
    fn capability_admits_only_the_local_scoretable() {
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/stick.json")).unwrap();
        let patterns: Vec<tauri::utils::acl::RemoteUrlPattern> = cap["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_str().unwrap().parse().unwrap())
            .collect();
        let allowed = |u: &str| patterns.iter().any(|p| p.test(&u.parse().unwrap()));
        assert!(allowed("http://localhost:5173/"));
        assert!(allowed("http://localhost:5174/?match=1"));
        assert!(!allowed("http://192.168.1.20:5173/"));
        assert!(!allowed("https://example.com/"));
        assert!(!allowed("http://localhost.evil.com:5173/"));
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
    }
}
