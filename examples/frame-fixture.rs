use anyhow::Result;
use basinsync::{
    event::{self, Marker},
    timeline::Basin,
};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
};

fn main() -> Result<()> {
    let mut json = String::new();
    io::stdin().read_to_string(&mut json)?;
    let markers: BTreeMap<String, Marker> = serde_json::from_str(&json)?;
    let (_, command) = Basin::default().prepare(markers)?;
    io::stdout().write_all(&event::encode(command)?)?;
    Ok(())
}
