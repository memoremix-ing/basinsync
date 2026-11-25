//! The FlexBuffers layout rule (docs round 5): a value must end at or before
//! the slot that refers to it.
use basinsync_codec::{flexbuffers, layout};

const OVERLAPPING: [&[u8]; 3] = [&[106, 2, 120, 1, 48, 1], &[0, 2, 120, 1, 48, 1], &[3, 120, 1, 48, 1]];

#[test]
fn overlapping_extensions_are_rejected() {
    for wire in OVERLAPPING {
        assert!(flexbuffers::decode_extension(wire).is_err(), "{wire:?}");
        assert!(layout::check_layout(wire).is_err(), "{wire:?}");
    }
    assert!(flexbuffers::decode_extension(&[2, 120, 1, 2, 48, 1]).is_ok());
    assert!(layout::check_layout(&[2, 120, 1, 2, 48, 1]).is_ok());
}

#[test]
fn writer_output_passes() {
    use std::collections::BTreeMap;
    let documents = [
        ::flexbuffers::to_vec(Vec::<(i64, String)>::new()).unwrap(),
        ::flexbuffers::to_vec(BTreeMap::<String, u32>::new()).unwrap(),
        ::flexbuffers::to_vec((vec![1i64, -2, 3], "text", BTreeMap::from([("k", vec![1u8, 2])]))).unwrap(),
        ::flexbuffers::to_vec((u64::MAX, vec!["a".to_string(), "bb".into()], 1.5f64)).unwrap(),
    ];
    for bytes in documents {
        assert!(layout::check_layout(&bytes).is_ok(), "{bytes:?}");
    }
}
