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
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--inspect") {
        let state = basinsync::turso::State::from_image(std::fs::read(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("missing database path"))?,
        )?)?;
        let flows: BTreeMap<_, _> = state
            .flows()?
            .into_iter()
            .map(|(flow, vp)| (flow, vp.decimal()))
            .collect();
        serde_json::to_writer(
            io::stdout(),
            &serde_json::json!({"milestone":state.milestone()?,"flows":flows}),
        )?;
        return Ok(());
    }
    let mut json = String::new();
    io::stdin().read_to_string(&mut json)?;
    let markers: BTreeMap<String, Marker> = serde_json::from_str(&json)?;
    let (_, command) = Basin::default().prepare(markers)?;
    io::stdout().write_all(&event::encode(command)?)?;
    Ok(())
}
