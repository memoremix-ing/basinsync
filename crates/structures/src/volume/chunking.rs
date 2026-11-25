use anyhow::{Result, ensure};
#[derive(Clone, Copy)]
pub struct ChunkPolicy {
    pub min: usize,
    pub target: usize,
    pub max: usize,
    pub mixed: bool,
    pub run_anchors: bool,
}
impl Default for ChunkPolicy {
    fn default() -> Self {
        Self {
            min: 16384,
            target: 65536,
            max: 262144,
            mixed: true,
            run_anchors: true,
        }
    }
}
pub fn chunks(input: &[u8], p: ChunkPolicy) -> Result<Vec<Vec<u8>>> {
    ensure!(
        p.min > 0
            && p.min <= p.target
            && p.target <= p.max
            && p.target.is_power_of_two()
            && p.target <= (1 << 24)
            && p.max <= (32 << 20),
        "invalid chunk policy"
    );
    let mut table = [0u32; 256];
    let mut x = 0x9e3779b9u32;
    for v in &mut table {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *v = x;
    }
    let mut output = vec![];
    let mut start = 0;
    let mut hash = 0u32;
    let mut last = None;
    let mut run = 0;
    for (at, &byte) in input.iter().enumerate() {
        if p.run_anchors && run >= 64 && last != Some(byte) && at - start >= p.min {
            output.push(input[start..at].to_vec());
            start = at;
            hash = 0;
            last = None;
            run = 0;
        }
        run = if last == Some(byte) { run + 1 } else { 1 };
        last = Some(byte);
        hash = (hash << 1).wrapping_add(table[byte as usize]);
        let mut boundary = hash;
        if p.mixed {
            boundary ^= boundary >> 16;
            boundary = boundary.wrapping_mul(0x7feb352d);
            boundary ^= boundary >> 15;
            boundary = boundary.wrapping_mul(0x846ca68b);
            boundary ^= boundary >> 16;
        }
        let used = at + 1 - start;
        if used >= p.max || (used >= p.min && boundary as usize & (p.target - 1) == 0) {
            output.push(input[start..=at].to_vec());
            start = at + 1;
            hash = 0;
            last = None;
            run = 0;
        }
    }
    if start < input.len() {
        output.push(input[start..].to_vec());
    }
    Ok(output)
}
