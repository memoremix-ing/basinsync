use anyhow::Result;
use basinsync::{
    event::{self, FlowCommand, Marker},
    lexidecimal::Viewpoint,
    timeline::Basin,
    turso::{State, wal::Writer},
};
use num_bigint::BigUint;
use std::collections::BTreeMap;
fn command(flow: &str, vp: &str) -> FlowCommand {
    FlowCommand {
        markers: BTreeMap::from([(
            flow.into(),
            Marker {
                viewpoint: vp.into(),
                sha384: event::digest(&[0, 255, 128]),
                blob: vec![0, 255, 128],
            },
        )]),
    }
}

#[test]
fn unpublished_state_is_not_readable_and_bootstrap_is_verified() -> Result<()> {
    let mut state = Basin::default();
    let prepared = state.prepare_wal(vec![command("f", "0")])?;
    assert!(state.latest("f").is_err());
    assert!(state.prepare_wal(vec![command("f", "1")]).is_err());
    let bytes = prepared.bytes().to_vec();
    let mut recovered = Basin::default();
    recovered.apply_entry(1u8.into(), &bytes)?;
    assert_eq!(recovered.latest("f")?.unwrap().decimal(), "0");
    let event::Entry::Wal {
        commands,
        mut delta,
    } = event::decode_entry(&bytes)?
    else {
        panic!()
    };
    delta.logical.base.as_mut().unwrap().0[0] ^= 1;
    let mut empty = Basin::default();
    assert!(
        empty
            .apply_entry(1u8.into(), &event::encode_wal(commands, *delta)?)
            .is_err()
    );
    assert!(empty.latest("f")?.is_none());
    Ok(())
}

#[test]
fn legacy_history_can_be_extended_with_wal_batches() -> Result<()> {
    let mut reader = Basin::default();
    let (_, legacy) = reader.prepare(command("f", "0").markers)?;
    let bytes = event::encode(legacy)?;
    reader.apply_entry(1u8.into(), &bytes)?;
    let prepared = reader.prepare_wal(vec![
        command("f", "1"),
        command("f", "2"),
        command("g", "0"),
    ])?;
    let mut recovered = Basin::default();
    recovered.apply_entry(1u8.into(), &bytes)?;
    recovered.apply_entry(2u8.into(), prepared.bytes())?;
    assert_eq!(recovered.latest("f")?.unwrap().decimal(), "2");
    assert_eq!(recovered.latest("g")?.unwrap().decimal(), "0");
    assert_eq!(recovered.head, Some(event::digest(prepared.bytes())));
    Ok(())
}

#[test]
fn corrupt_frames_lineage_order_and_versions_fail_atomically() -> Result<()> {
    let mut writer = Writer::open(&State::genesis()?.image)?;
    let commands = vec![command("f", "0")];
    let delta = writer.prepare(&0u8.into(), None, &commands)?;
    let first = event::encode_wal(commands, delta)?;
    let mut reader = Basin::default();
    reader.apply_entry(1u8.into(), &first)?;
    let commands = vec![command("f", "1"), command("f", "2")];
    let delta = writer.prepare(&1u8.into(), Some(&event::digest(&first)), &commands)?;
    for fault in 0..7 {
        let mut bad = delta.clone();
        let mut inputs = commands.clone();
        match fault {
            0 => bad.version = "unknown".into(),
            1 => bad.physical.parent = Some("00".repeat(48)),
            2 => bad.physical.segments[0].0[56] ^= 1,
            3 => {
                bad.physical.segments[0].0.pop();
            }
            4 => bad.logical.frames[0].0[0] ^= 1,
            5 => inputs.reverse(),
            _ => bad.physical.format = "unknown".into(),
        }
        assert!(
            reader
                .apply_entry(2u8.into(), &event::encode_wal(inputs, bad)?)
                .is_err(),
            "fault {fault}"
        );
        assert_eq!(reader.milestone, 1u8.into());
        assert_eq!(reader.latest("f")?.unwrap().decimal(), "0");
        assert_eq!(reader.head, Some(event::digest(&first)));
    }
    reader.apply_entry(2u8.into(), &event::encode_wal(commands, delta)?)?;
    assert_eq!(reader.latest("f")?.unwrap().decimal(), "2");
    Ok(())
}

#[test]
fn wal_preserves_counters_above_machine_precision() -> Result<()> {
    let huge = BigUint::from(1u8) << 256usize;
    let (base, _) = State::genesis()?.stage(
        &huge.to_string(),
        &command("f", &huge.to_string()).markers,
        true,
    )?;
    let mut writer = Writer::open(&base.image)?;
    let next = (&huge + 1u8).to_string();
    let inputs = vec![command("f", &next)];
    let delta = writer.prepare(&huge, Some("prior-record"), &inputs)?;
    let image = delta
        .physical
        .ingest(&base.image, &huge, Some("prior-record"))?;
    let recovered = State::from_image(image)?;
    assert_eq!(recovered.milestone()?, next);
    assert_eq!(recovered.latest("f")?.unwrap().decimal(), next);
    Ok(())
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(32))]
    #[test]
    fn persistent_wal_batches_reconstruct_at_every_prefix(batches in proptest::collection::vec(proptest::collection::vec(0u16..64,1..20),2..30)){
        let mut before=State::genesis().unwrap().image;
        let mut writer=Writer::open(&before).unwrap();let mut reader=Basin::default();
        let mut latest:BTreeMap<String,Viewpoint>=BTreeMap::new();
        for (index,batch) in batches.into_iter().enumerate(){
            let mut commands=Vec::new();
            for id in batch {let flow=format!("{id}/雪");let vp=latest.get(&flow).map_or_else(Viewpoint::zero,Viewpoint::next);commands.push(command(&flow,&vp.decimal()));latest.insert(flow,vp);}
            let delta=writer.prepare(&reader.milestone,reader.head.as_deref(),&commands).unwrap();
            let bytes=event::encode_wal(commands,delta.clone()).unwrap();
            reader.apply_entry((index+1).into(),&bytes).unwrap();
            let image=&reader.database.as_ref().unwrap().image;
            let logical=State::ingest_logical(&before,&delta.logical).unwrap();
            proptest::prop_assert_eq!(image,&writer.image().unwrap());proptest::prop_assert_eq!(image,&logical.image);
            proptest::prop_assert_eq!(reader.database.as_ref().unwrap().flows().unwrap(),latest.clone());
            before=image.clone();
        }
    }
}
