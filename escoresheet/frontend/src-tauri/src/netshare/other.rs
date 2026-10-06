//! Other systems (macOS): no tablet network from the app. The dialog says so
//! and points to the system's own Internet Sharing or a travel router.

use super::{BluetoothStatus, Credentials, HotspotStatus, NetError};
use tauri::{AppHandle, Runtime};

#[derive(Default)]
pub struct Inner;

pub async fn hotspot_status(_inner: &mut Inner) -> HotspotStatus {
    HotspotStatus { reason: Some("unsupported-os"), ..Default::default() }
}

pub async fn hotspot_start(_inner: &mut Inner, _c: &Credentials) -> Result<(), NetError> {
    Err(NetError::new("unsupported-os", ""))
}

pub async fn hotspot_stop(_inner: &mut Inner) -> Result<(), NetError> {
    Ok(())
}

pub async fn bluetooth_status(_inner: &mut Inner) -> BluetoothStatus {
    BluetoothStatus { reason: Some("unsupported-os"), ..Default::default() }
}

pub async fn bluetooth_start(_inner: &mut Inner) -> Result<(), NetError> {
    Err(NetError::new("unsupported-os", ""))
}

pub async fn bluetooth_stop(_inner: &mut Inner) -> Result<(), NetError> {
    Ok(())
}

pub fn recover<R: Runtime>(_app: &AppHandle<R>) {}
