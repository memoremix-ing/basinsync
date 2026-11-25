package structures

type packedBuilt struct {
	node  Node
	edges []Edge
}
type packedChildren struct {
	slots   []any
	edges   []Edge
	inlined int
}

func packChildren(b *Basin, children []packedBuilt, own int, refs []Edge) packedChildren {
	inlined := own
	all := append([]Edge{}, refs...)
	for _, c := range children {
		inlined += int(uint32Value(field(c.node["5"], "inlined")))
		all = append(all, c.edges...)
	}
	cut := len(children) > 0 && (inlined > 1280 || len(distinct(all)) > b.MaxDegree)
	slots := []any{}
	edges := append([]Edge{}, refs...)
	for _, c := range children {
		if cut {
			e := b.seal(c.node, c.edges)
			slots = append(slots, e)
			edges = append(edges, e)
		} else {
			slots = append(slots, c.node)
			edges = append(edges, c.edges...)
		}
	}
	if cut {
		inlined = own
	}
	return packedChildren{slots, distinct(edges), inlined}
}
func packedNode(b *Basin, path string, header any, footer []any, edges []Edge) packedBuilt {
	return packedBuilt{Node{"0": Symbol{Name: "species"}, "1": Domain, "2": path, "3": query(edges, b.MaxDegree, b.MaxHeight), "4": int64(0), "5": header, "6": footer}, edges}
}
func valueEdges(values []any, c Consumer) []Edge {
	refs := []Edge{}
	if c.Edges != nil {
		for _, v := range values {
			refs = append(refs, checked(c.Edges(v))...)
		}
	}
	return refs
}

func plainVector(r Ref) bool { return r.typ != 12 && (r.typ >= 10 && r.typ <= 24 || r.typ == 36) }
