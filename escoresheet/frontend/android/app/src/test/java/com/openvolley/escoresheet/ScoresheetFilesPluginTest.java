package com.openvolley.escoresheet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.nio.file.Files;

import org.junit.Test;

/** Open / Share only ever hand out a PDF inside a scoresheet folder. */
public class ScoresheetFilesPluginTest {

    @Test
    public void onlyPdfsInsideTheScoresheetFolders() throws Exception {
        File base = Files.createTempDirectory("ov-files").toFile();
        File root = new File(base, "Documents/OpenVolley/scoresheets");
        assertEquals(true, root.mkdirs());
        File pdf = new File(root, "20261007_382208_KSCW-H1_vs_Spada-H1.pdf");
        Files.write(pdf.toPath(), "%PDF-1.3".getBytes());
        File other = new File(base, "Documents/secret.pdf");
        Files.write(other.toPath(), "%PDF-1.3".getBytes());
        File txt = new File(root, "notes.txt");
        Files.write(txt.toPath(), "x".getBytes());
        File[] roots = { root, null };

        assertEquals(pdf.getCanonicalFile(), ScoresheetFilesPlugin.allowedPdf(pdf.getPath(), roots));
        // outside the folder, through "..", not a PDF, missing, nothing
        assertNull(ScoresheetFilesPlugin.allowedPdf(other.getPath(), roots));
        assertNull(ScoresheetFilesPlugin.allowedPdf(root.getPath() + "/../../secret.pdf", roots));
        assertNull(ScoresheetFilesPlugin.allowedPdf(txt.getPath(), roots));
        assertNull(ScoresheetFilesPlugin.allowedPdf(root.getPath() + "/missing.pdf", roots));
        assertNull(ScoresheetFilesPlugin.allowedPdf("", roots));
        assertNull(ScoresheetFilesPlugin.allowedPdf(null, roots));
    }
}
