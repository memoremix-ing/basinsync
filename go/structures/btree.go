package structures

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"sort"
)

const BTreePath = ".btree-node/"

type btreeRow struct {
	key            []byte
	value, summary any
}

func btreeCapacity(depth int) int {
	n := 1
	for i := 0; i <= depth; i++ {
		if n > int(^uint(0)>>1)/32 {
			return int(^uint(0) >> 1)
		}
		n *= 32
	}
	return n - 1
}
func btreeBuildNode(b *Basin, rows []btreeRow, depth int, root bool, c Consumer) packedBuilt {
	own := []btreeRow{}
	children := []packedBuilt{}
	if depth == 0 {
		own = append(own, rows...)
	} else {
		maxChild := btreeCapacity(depth-1) + 1
		count := (len(rows) + 1 + maxChild - 1) / maxChild
		minimum := 16
		if root {
			minimum = 2
		}
		if count < minimum {
			count = minimum
		}
		left := len(rows) - count + 1
		base, extra := left/count, left%count
		at := 0
		for i := 0; i < count; i++ {
			n := base
			if i < extra {
				n++
			}
			children = append(children, btreeBuildNode(b, rows[at:at+n], depth-1, false, c))
			at += n
			if i+1 < count {
				own = append(own, rows[at])
				at++
			}
		}
		require(at == len(rows), "B-tree partition mismatch")
	}
	keys, values, parts := []any{}, []any{}, []any{}
	for _, r := range own {
		keys = append(keys, r.key)
		values = append(values, r.value)
	}
	for _, r := range rows {
		parts = append(parts, r.summary)
	}
	p := packChildren(b, children, len(own), valueEdges(values, c))
	summary := c.Empty
	if len(rows) > 0 {
		summary = checked(c.Combine(parts))
	}
	var bounds, child any
	if len(rows) > 0 {
		bounds = vector(rows[0].key, rows[len(rows)-1].key)
	}
	if depth > 0 {
		child = p.slots
	}
	return packedNode(b, BTreePath, map[string]any{"count": big.NewInt(int64(len(rows))), "depth": int64(depth), "inlined": int64(p.inlined), "keys": bounds}, vector(c.Migration, summary, keys, values, child), p.edges)
}
func BuildBTree(b *Basin, input []Entry, c Consumer) (edge Edge, err error) {
	defer protect(&err)
	rows := []btreeRow{}
	for _, r := range input {
		k := append([]byte{}, r.Key...)
		rows = append(rows, btreeRow{k, r.Value, checked(c.Entry(k, r.Value))})
	}
	sort.Slice(rows, func(i, j int) bool { return bytes.Compare(rows[i].key, rows[j].key) < 0 })
	for i := 1; i < len(rows); i++ {
		require(!bytes.Equal(rows[i-1].key, rows[i].key), "duplicate B-tree key")
	}
	depth := 0
	for len(rows) > btreeCapacity(depth) {
		depth++
	}
	n := btreeBuildNode(b, rows, depth, true, c)
	return b.seal(n.node, n.edges), nil
}
func btreeRoot(e Edge, migration int64) any {
	validateEdge(e)
	require(text(e[1]) == Domain && text(e[2]) == BTreePath && integer(field(e[6], "0")) == migration, "unsupported B-tree migration")
	return e[5]
}
func btreeIncludes(h any, k []byte) bool {
	bounds := field(h, "keys")
	return bounds != nil && bytes.Compare(blob(at(bounds, 0)), k) <= 0 && bytes.Compare(k, blob(at(bounds, 1))) <= 0
}
func btreeIntersects(h any, lo, hi []byte) bool {
	bounds := field(h, "keys")
	return bounds != nil && bytes.Compare(blob(at(bounds, 1)), lo) >= 0 && (hi == nil || bytes.Compare(blob(at(bounds, 0)), hi) < 0)
}
func btreeParts(r Ref, migration int64) (h any, keys, values, children Ref) {
	validateNode(r, BTreePath)
	h = r.get("5").owned(0)
	depth := uint32Value(field(h, "depth"))
	require(depth < 256 && bigint(field(h, "count")).Sign() >= 0, "invalid B-tree header")
	f := r.get("6")
	require(f.len() == 5 && integer(f.item(0).owned(0)) == migration, "unsupported B-tree migration")
	keys, values, children = f.item(2), f.item(3), f.item(4)
	require(plainVector(keys) && plainVector(values) && keys.len() <= 31 && keys.len() == values.len() && (depth == 0 && children.typ == 0 || depth > 0 && plainVector(children) && children.len() == keys.len()+1), "invalid B-tree node")
	return
}
func GetBTreeView(b *Basin, e Edge, k []byte, migration int64) (view *Ref, err error) {
	defer protect(&err)
	if !btreeIncludes(btreeRoot(e, migration), k) {
		return nil, nil
	}
	r := b.load(e)
	for depth := 0; depth < 256; depth++ {
		_, keys, values, children := btreeParts(r, migration)
		lo, hi := 0, keys.len()
		for lo < hi {
			mid := (lo + hi) / 2
			if bytes.Compare(keys.item(mid).bytes(), k) < 0 {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo < keys.len() && bytes.Equal(keys.item(lo).bytes(), k) {
			v := values.item(lo)
			return &v, nil
		}
		if children.typ == 0 {
			return nil, nil
		}
		next := children.item(lo)
		if next.typ == 9 {
			r = next
		} else {
			e := array(next.owned(0))
			if !btreeIncludes(e[5], k) {
				return nil, nil
			}
			r = b.load(e)
		}
	}
	require(false, "B-tree nesting limit")
	return nil, nil
}
func GetBTree(b *Basin, e Edge, k []byte, migration int64) (value any, found bool, err error) {
	defer protect(&err)
	v := checked(GetBTreeView(b, e, k, migration))
	if v == nil {
		return nil, false, nil
	}
	return v.owned(0), true, nil
}

type btreeWalk struct {
	basin     *Basin
	lo, hi    []byte
	migration int64
	accept    func(any, any) bool
	emit      func([]byte, Ref) (bool, error)
}

func (w *btreeWalk) walk(r Ref, depth int) bool {
	require(depth < 256, "B-tree nesting limit")
	h, keys, values, children := btreeParts(r, w.migration)
	if !btreeIntersects(h, w.lo, w.hi) || !w.accept(h, r.get("6").item(1).owned(0)) {
		return true
	}
	for i := 0; i <= keys.len(); i++ {
		if children.typ != 0 {
			at := children.item(i)
			if at.typ == 9 {
				if !w.walk(at, depth+1) {
					return false
				}
			} else {
				e := array(at.owned(0))
				if btreeIntersects(e[5], w.lo, w.hi) && w.accept(e[5], field(e[6], "1")) && !w.walk(w.basin.load(e), depth+1) {
					return false
				}
			}
		}
		if i < keys.len() {
			k := keys.item(i).bytes()
			if bytes.Compare(k, w.lo) >= 0 && (w.hi == nil || bytes.Compare(k, w.hi) < 0) && !checked(w.emit(append([]byte{}, k...), values.item(i))) {
				return false
			}
		}
	}
	return true
}
func VisitBTree(b *Basin, e Edge, lo, hi []byte, migration int64, accept func(any, any) bool, emit func([]byte, Ref) (bool, error)) (err error) {
	defer protect(&err)
	require(hi == nil || bytes.Compare(lo, hi) <= 0, "invalid B-tree range")
	h := btreeRoot(e, migration)
	if btreeIntersects(h, lo, hi) && accept(h, field(e[6], "1")) {
		w := btreeWalk{b, lo, hi, migration, accept, emit}
		w.walk(b.load(e), 0)
	}
	return nil
}
func BTreeEntries(b *Basin, e Edge, migration int64) (rows []Entry, err error) {
	rows = []Entry{}
	err = VisitBTree(b, e, nil, nil, migration, func(any, any) bool { return true }, func(k []byte, r Ref) (bool, error) { rows = append(rows, Entry{k, r.owned(0)}); return true, nil })
	return
}
func UpdateBTree(b *Basin, e Edge, changes []Change, c Consumer) (edge Edge, err error) {
	defer protect(&err)
	values := map[string]Entry{}
	for _, r := range checked(BTreeEntries(b, e, c.Migration)) {
		values[hex.EncodeToString(r.Key)] = r
	}
	for _, r := range changes {
		k := hex.EncodeToString(r.Key)
		if r.Delete {
			delete(values, k)
		} else {
			values[k] = Entry{r.Key, r.Value}
		}
	}
	rows := []Entry{}
	for _, r := range values {
		rows = append(rows, r)
	}
	return BuildBTree(b, rows, c)
}
