#[cfg(unix)]
pub(crate) use std::os::unix::fs::FileExt;

// Callers must serialize fallback file-position operations for each file.
#[cfg(not(unix))]
pub(crate) trait FileExt {
    fn read_exact_at(&self, bytes: &mut [u8], pos: u64) -> std::io::Result<()>;
    fn write_all_at(&self, bytes: &[u8], pos: u64) -> std::io::Result<()>;
}
#[cfg(not(unix))]
impl FileExt for std::fs::File {
    fn read_exact_at(&self, bytes: &mut [u8], pos: u64) -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = self;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(bytes)
    }
    fn write_all_at(&self, bytes: &[u8], pos: u64) -> std::io::Result<()> {
        use std::io::{Seek, SeekFrom};
        let mut file = self;
        file.seek(SeekFrom::Start(pos))?;
        file.write_all(bytes)
    }
}
