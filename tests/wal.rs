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
                context: Default::default(),
                edges: Default::default(),
                verified: Default::default(),
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
        ..
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
fn concatenated_events_keep_boundaries_alignment_ranges_and_recovery() -> Result<()> {
    let mut stager = Basin::default().into_stager();
    let mut events = Vec::new();
    for n in 0..3 {
        events.push(
            stager
                .prepare(vec![command("f", &n.to_string())])?
                .bytes()
                .to_vec(),
        );
    }
    let mut feed = vec![];
    basinsync::envbuf::append(&mut feed, &[1], basinsync::envbuf::MARGIN)?;
    for bytes in &events {
        feed.extend_from_slice(bytes);
    }
    let mut recovered = Basin::default();
    let frames = basinsync::envbuf::all(&feed)?;
    assert_eq!(frames.len(), 7);
    let mut end = feed.len();
    for frame in frames.iter().rev() {
        assert_eq!(*frame, basinsync::envbuf::before(&feed, end)?);
        end = frame.start;
    }
    assert_eq!(end, 0);
    for (n, frame) in frames
        .iter()
        .filter(|frame| frame.format == basinsync::envbuf::NESTED)
        .enumerate()
    {
        assert_eq!(frame.format, basinsync::envbuf::NESTED);
        let bytes = &feed[frame.start..frame.end];
        let borrowed = basinsync::envbuf::nested_message(bytes)?;
        assert_eq!(borrowed.as_ptr(), frame.content.as_ptr());
        for inner in basinsync::envbuf::all(borrowed)? {
            assert_eq!((frame.content_start + inner.content_start) % 8, 0);
        }
        assert_eq!(
            event::entry_digest(bytes)?,
            event::entry_digest(&events[n])?
        );
        for range in event::blob_ranges(bytes)? {
            let start = frame.start + usize::try_from(range.offset)?;
            let blob = &feed[start..start + usize::try_from(range.length)?];
            assert_eq!(blob, &[0, 255, 128]);
        }
        recovered.apply_entry((n + 1).into(), bytes)?;
    }
    assert_eq!(recovered.prefix(), stager.prefix());
    assert_eq!(recovered.latest("f")?.unwrap().decimal(), "2");
    assert!(event::decode_entry(&feed).is_err());
    assert!(event::decode_entry(event::envelope(&events[0])?.content).is_err());
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
    assert_eq!(recovered.head, Some(event::entry_digest(prepared.bytes())?));
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
    let delta = writer.prepare(&1u8.into(), Some(&event::entry_digest(&first)?), &commands)?;
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
        assert_eq!(reader.head, Some(event::entry_digest(&first)?));
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
    let location = recovered.location("f", &Viewpoint::parse(&next)?)?.unwrap();
    assert_eq!(location.upstream, &huge + 1u8);
    let bytes = event::encode_wal(inputs, delta)?;
    assert_eq!(
        &bytes[location.offset as usize..(location.offset + location.length) as usize],
        &[0, 255, 128]
    );
    Ok(())
}

proptest::proptest! {
    // Each run draws new cases; set PROPTEST_CASES for a deeper search.
    #![proptest_config(proptest::test_runner::Config::with_cases(std::env::var("PROPTEST_CASES").ok().and_then(|c| c.parse().ok()).unwrap_or(32)))]
    #[test]
    fn persistent_wal_batches_reconstruct_at_every_prefix(batches in proptest::collection::vec(proptest::collection::vec(0u16..64,1..20),2..30)){
        let mut before=State::genesis().unwrap().image;
        let mut writer=Writer::open(&before).unwrap();let mut reader=Basin::default();
        let mut latest:BTreeMap<String,Viewpoint>=BTreeMap::new();
        for (index,batch) in batches.into_iter().enumerate(){
            let mut commands=Vec::new();
            for id in batch {let flow=format!("{id}-snow");let vp=latest.get(&flow).map_or_else(Viewpoint::zero,Viewpoint::next);commands.push(command(&flow,&vp.decimal()));latest.insert(flow,vp);}
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

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(std::env::var("PROPTEST_CASES").ok().and_then(|c| c.parse().ok()).unwrap_or(32)))]
    /// Writers rewrite the trailing counter margin and may append more margins when they
    /// retry a conditional PUT; none of that may change the entry's identity.
    #[test]
    fn trailing_retry_margins_never_change_an_entry(
        counter in proptest::prelude::any::<u64>(),
        margins in proptest::collection::vec(proptest::collection::vec(proptest::prelude::any::<u8>(), 0..64), 0..4),
    ) {
        let mut stager = Basin::default().into_stager();
        let first = stager.prepare(vec![command("f", "0")]).unwrap();
        let second = stager.prepare(vec![command("f", "1")]).unwrap();
        let original = first.bytes();
        let mut stored = original.to_vec();
        let mut margin = vec![];
        basinsync::envbuf::append(&mut margin, &counter.to_le_bytes(), basinsync::envbuf::MARGIN).unwrap();
        let start = event::envelope(original).unwrap().end;
        stored[start..start + margin.len()].copy_from_slice(&margin);
        proptest::prop_assert_eq!(stored.len(), original.len());
        for margin in &margins {
            basinsync::envbuf::append(&mut stored, margin, basinsync::envbuf::MARGIN).unwrap();
        }
        proptest::prop_assert_eq!(event::coordinate_bytes(&stored).unwrap(), event::coordinate_bytes(original).unwrap());
        proptest::prop_assert_eq!(event::entry_digest(&stored).unwrap(), event::entry_digest(original).unwrap());
        proptest::prop_assert_eq!(event::blob_ranges(&stored).unwrap(), event::blob_ranges(original).unwrap());
        proptest::prop_assert_eq!(event::manifest_range(&stored).unwrap(), event::manifest_range(original).unwrap());
        proptest::prop_assert_eq!(basinsync::checksum::event(0, &stored).unwrap(), basinsync::checksum::event(0, original).unwrap());
        let mut recovered = Basin::default();
        recovered.apply_entry(1u8.into(), &stored).unwrap();
        recovered.apply_entry(2u8.into(), second.bytes()).unwrap();
        proptest::prop_assert_eq!(recovered.prefix(), stager.prefix());
        proptest::prop_assert_eq!(recovered.latest("f").unwrap().unwrap().decimal(), "1");
    }
}

#[test]
fn byte_coordinates_are_digest_bound_and_contiguous() -> Result<()> {
    let mut stager = Basin::default().into_stager();
    let first = stager.prepare(vec![command("f", "0")])?;
    let second = stager.prepare(vec![command("f", "1")])?;
    let original = first.bytes();
    let bytes = event::coordinate_bytes(original)?;
    assert_eq!(event::envelope(original)?.end, bytes.len());
    assert_eq!(event::entry_digest(original)?, event::digest(bytes));
    assert_eq!(
        basinsync::checksum::event(0, original)?,
        basinsync::checksum::append(0, bytes)
    );
    assert_eq!(event::coordinate(original)?, Some(0u8.into()));
    assert_eq!(
        event::coordinate(second.bytes())?,
        Some(event::coordinate_length(original)?.into())
    );
    assert_eq!(
        stager.prefix().coordinate(),
        &BigUint::from(
            event::coordinate_length(original)? + event::coordinate_length(second.bytes())?
        )
    );
    let event::Entry::Wal {
        commands, delta, ..
    } = event::decode_entry(original)?
    else {
        panic!()
    };
    for wrong in [1u8.into(), BigUint::from(1u8) << 256usize] {
        let bad = event::encode_wal_at(commands.clone(), *delta.clone(), &wrong)?;
        assert_eq!(event::coordinate(&bad)?, Some(wrong));
        assert_ne!(event::entry_digest(&bad)?, event::entry_digest(original)?);
        let mut recovered = Basin::default();
        assert!(recovered.apply_entry(1u8.into(), &bad).is_err());
        assert_eq!(recovered.milestone, 0u8.into());
        assert!(recovered.database.is_none());
    }
    Ok(())
}

#[test]
fn entries_reject_non_margin_suffixes_truncation_and_internal_margins() -> Result<()> {
    let original = Basin::default()
        .into_stager()
        .prepare(vec![command("f", "0")])?;
    let original = original.bytes();
    for format in [basinsync::envbuf::NESTED, basinsync::envbuf::FLEXBUFFERS, 0] {
        let mut stored = original.to_vec();
        basinsync::envbuf::append(&mut stored, b"unexpected", format)?;
        assert!(event::decode_entry(&stored).is_err());
        assert!(event::coordinate_bytes(&stored).is_err());
    }
    let mut truncated = original.to_vec();
    truncated.pop();
    assert!(event::decode_entry(&truncated).is_err());
    // Margins within the command feed belong in its manifest; they cannot trail it.
    let mut internal = vec![0; 8];
    internal.extend_from_slice(event::envelope(original)?.content);
    basinsync::envbuf::append_counter_margin(&mut internal, 0)?;
    let internal = basinsync::envbuf::finish_nested(internal)?;
    assert!(event::decode_entry(&internal).is_err());
    Ok(())
}
