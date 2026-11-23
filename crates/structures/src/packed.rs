use crate::{
    Value,
    basin::{self, Basin, Edge, Storage},
};
use Value::*;
use anyhow::Result;
pub(crate) struct Built {
    pub node: Value,
    pub edges: Vec<Edge>,
}
pub(crate) struct Packed {
    pub slots: Vec<Value>,
    pub edges: Vec<Edge>,
    pub inlined: usize,
}
pub(crate) fn pack<S: Storage>(
    basin: &mut Basin<S>,
    children: Vec<Built>,
    own: usize,
    refs: Vec<Edge>,
) -> Result<Packed> {
    let inlined = children.iter().try_fold(own, |n, c| {
        Ok::<_, anyhow::Error>(n + c.node.index(5)?.field("inlined")?.number()? as usize)
    })?;
    let all = basin::distinct(
        &[
            refs.clone(),
            children.iter().flat_map(|c| c.edges.clone()).collect(),
        ]
        .concat(),
    )?;
    let cut = !children.is_empty() && (inlined > 1280 || all.len() > basin.max_degree);
    let mut slots = vec![];
    let mut edges = refs;
    for c in children {
        if cut {
            let e = basin.seal(c.node, &c.edges)?;
            slots.push(e.clone());
            edges.push(e);
        } else {
            slots.push(c.node);
            edges.extend(c.edges);
        }
    }
    Ok(Packed {
        slots,
        edges: basin::distinct(&edges)?,
        inlined: if cut { own } else { inlined },
    })
}
pub(crate) fn built<S: Storage>(
    b: &Basin<S>,
    path: &str,
    header: Value,
    footer: Vec<Value>,
    edges: Vec<Edge>,
) -> Result<Built> {
    Ok(Built {
        node: Value::map([
            ("0", Symbol("species".into())),
            ("1", basin::DOMAIN.into()),
            ("2", path.into()),
            ("3", basin::query(&edges, b.max_degree, b.max_height)?),
            ("4", 0u32.into()),
            ("5", header),
            ("6", Array(footer)),
        ]),
        edges,
    })
}

pub(crate) fn plain_vector(r: flexbuffers::Reader<&[u8]>) -> bool {
    use flexbuffers::FlexBufferType as T;
    let t = r.flexbuffer_type();
    t.is_vector() && !matches!(t, T::Map | T::VectorUInt)
}
