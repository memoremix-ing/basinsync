package structures

import (
	"math/big"
	"math/bits"
	"sort"
)

const VectorPath = ".vector-node/"

type VectorEntry struct {
	Index *big.Int
	Value any
}
type VectorChange struct {
	Index  *big.Int
	Value  any
	Delete bool
}
type vectorRow struct {
	index          *big.Int
	value, summary any
}

func nonnegative(i *big.Int) { require(i != nil && i.Sign() >= 0, "invalid vector index") }
func indexBytes(i *big.Int) []byte {
	b := i.Bytes()
	if len(b) == 0 {
		return []byte{0}
	}
	return b
}
func vectorBuildNode(b *Basin, rows []vectorRow, base, span *big.Int, shift uint, c Consumer, bitsPerNode uint) packedBuilt {
	width := new(big.Int).Lsh(big.NewInt(1), shift)
	bitmap := make([]byte, ((1<<bitsPerNode)+7)/8)
	children := []packedBuilt{}
	values := []any{}
	for slot := 0; slot < (1 << bitsPerNode); slot++ {
		lo := new(big.Int).Add(base, new(big.Int).Mul(width, big.NewInt(int64(slot))))
		hi := new(big.Int).Add(lo, width)
		part := []vectorRow{}
		for _, r := range rows {
			if r.index.Cmp(lo) >= 0 && r.index.Cmp(hi) < 0 {
				part = append(part, r)
			}
		}
		if len(part) == 0 {
			continue
		}
		bitmap[slot/8] |= 1 << (slot % 8)
		if shift == 0 {
			values = append(values, part[0].value)
		} else {
			size := new(big.Int).Sub(span, new(big.Int).Mul(width, big.NewInt(int64(slot))))
			if size.Cmp(width) > 0 {
				size.Set(width)
			}
			children = append(children, vectorBuildNode(b, part, lo, size, shift-bitsPerNode, c, bitsPerNode))
		}
	}
	p := packChildren(b, children, len(values), valueEdges(values, c))
	summary := c.Empty
	if len(rows) > 0 {
		parts := []any{}
		for _, r := range rows {
			parts = append(parts, r.summary)
		}
		summary = checked(c.Combine(parts))
	}
	slots := values
	if shift > 0 {
		slots = p.slots
	}
	return packedNode(b, VectorPath, map[string]any{"length": new(big.Int).Set(span), "count": big.NewInt(int64(len(rows))), "bits": int64(bitsPerNode), "shift": int64(shift), "inlined": int64(p.inlined)}, vector(c.Migration, summary, bitmap, slots), p.edges)
}
func BuildVector(b *Basin, values []any, c Consumer, options ...uint) (edge Edge, err error) {
	defer protect(&err)
	rows := make([]VectorEntry, len(values))
	for i, v := range values {
		rows[i] = VectorEntry{big.NewInt(int64(i)), v}
	}
	return BuildVectorEntries(b, big.NewInt(int64(len(values))), rows, c, options...)
}
func BuildVectorEntries(b *Basin, length *big.Int, input []VectorEntry, c Consumer, options ...uint) (edge Edge, err error) {
	defer protect(&err)
	n := buildVectorNodeEntries(b, length, input, c, options...)
	return b.seal(n.node, n.edges), nil
}
func buildVectorNodeEntries(b *Basin, length *big.Int, input []VectorEntry, c Consumer, options ...uint) packedBuilt {
	bitsPerNode := uint(5)
	require(len(options) <= 1, "too many vector options")
	if len(options) > 0 {
		bitsPerNode = options[0]
	}
	require(bitsPerNode >= 1 && bitsPerNode <= 8, "vector bits must be 1..8")
	nonnegative(length)
	rows := []vectorRow{}
	for _, r := range input {
		nonnegative(r.Index)
		require(r.Index.Cmp(length) < 0, "vector index outside length")
		rows = append(rows, vectorRow{new(big.Int).Set(r.Index), r.Value, checked(c.Entry(indexBytes(r.Index), r.Value))})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].index.Cmp(rows[j].index) < 0 })
	for i := 1; i < len(rows); i++ {
		require(rows[i-1].index.Cmp(rows[i].index) != 0, "duplicate vector index")
	}
	shift := uint(0)
	for length.Cmp(new(big.Int).Lsh(big.NewInt(1), shift+bitsPerNode)) > 0 {
		shift += bitsPerNode
		require(shift/bitsPerNode < 256, "vector nesting limit")
	}
	n := vectorBuildNode(b, rows, new(big.Int), length, shift, c, bitsPerNode)
	return n
}
func vectorRoot(e Edge, migration int64) any {
	validateEdge(e)
	require(text(e[1]) == Domain && text(e[2]) == VectorPath && integer(field(e[6], "0")) == migration, "unsupported vector migration")
	return e[5]
}
func vectorParts(r Ref, migration int64) (h any, bitmap []byte, slots Ref) {
	validateNode(r, VectorPath)
	h = r.get("5").owned(0)
	length, count := bigint(field(h, "length")), bigint(field(h, "count"))
	shift := uint32Value(field(h, "shift"))
	bitsPerNode := uint32Value(field(h, "bits"))
	require(length.Sign() >= 0 && count.Sign() >= 0 && count.Cmp(length) <= 0 && bitsPerNode >= 1 && bitsPerNode <= 8 && shift%bitsPerNode == 0 && shift/bitsPerNode < 256, "invalid vector header")
	f := r.get("6")
	require(f.len() == 4 && integer(f.item(0).owned(0)) == migration, "unsupported vector migration")
	bitmap = blob(f.item(2).owned(0))
	require(len(bitmap) == ((1<<bitsPerNode)+7)/8 && (bitsPerNode >= 3 || bitmap[0]>>(1<<bitsPerNode) == 0), "invalid vector bitmap length/bits")
	slots = f.item(3)
	require(plainVector(slots) && slots.len() == vectorRank(bitmap, uint(len(bitmap)*8)), "invalid vector bitmap")
	return
}
func GetVectorView(b *Basin, e Edge, index *big.Int, migration int64) (v *Ref, err error) {
	defer protect(&err)
	nonnegative(index)
	h := vectorRoot(e, migration)
	if index.Cmp(bigint(field(h, "length"))) >= 0 || bigint(field(h, "count")).Sign() == 0 {
		return nil, nil
	}
	return getVectorInline(b, b.load(e), index, migration), nil
}
func getVectorInline(b *Basin, r Ref, index *big.Int, migration int64) *Ref {
	nonnegative(index)
	h, _, _ := vectorParts(r, migration)
	if index.Cmp(bigint(field(h, "length"))) >= 0 || bigint(field(h, "count")).Sign() == 0 {
		return nil
	}
	bitsPerNode := uint32Value(field(h, "bits"))
	local := new(big.Int).Set(index)
	for depth := 0; depth < 256; depth++ {
		h, bitmap, slots := vectorParts(r, migration)
		require(uint32Value(field(h, "bits")) == bitsPerNode, "inconsistent vector bits")
		shift := uint(uint32Value(field(h, "shift")))
		slot := uint(new(big.Int).And(new(big.Int).Rsh(local, shift), big.NewInt((1<<bitsPerNode)-1)).Uint64())
		if bitmap[slot/8]&(1<<(slot%8)) == 0 {
			return nil
		}
		rank := vectorRank(bitmap, uint(slot))
		at := slots.item(rank)
		if shift == 0 {
			return &at
		}
		local.Mod(local, new(big.Int).Lsh(big.NewInt(1), shift))
		if at.typ == 9 {
			r = at
		} else {
			r = b.load(array(at.owned(0)))
		}
	}
	require(false, "vector nesting limit")
	return nil
}
func GetVector(b *Basin, e Edge, index *big.Int, migration int64) (value any, found bool, err error) {
	defer protect(&err)
	v := checked(GetVectorView(b, e, index, migration))
	if v == nil {
		return nil, false, nil
	}
	return v.owned(0), true, nil
}

func vectorRank(bitmap []byte, slot uint) int {
	n := 0
	for _, b := range bitmap[:slot/8] {
		n += bits.OnesCount8(b)
	}
	if slot%8 != 0 {
		n += bits.OnesCount8(bitmap[slot/8] & byte((1<<(slot%8))-1))
	}
	return n
}

type vectorWalk struct {
	basin       *Basin
	from, to    *big.Int
	migration   int64
	bitsPerNode uint32
	accept      func(any, any) bool
	emit        func(*big.Int, Ref) (bool, error)
}

func (w *vectorWalk) walk(r Ref, base *big.Int, depth int) bool {
	require(depth < 256, "vector nesting limit")
	h, bitmap, slots := vectorParts(r, w.migration)
	require(uint32Value(field(h, "bits")) == w.bitsPerNode, "inconsistent vector bits")
	if base.Cmp(w.to) >= 0 || new(big.Int).Add(base, bigint(field(h, "length"))).Cmp(w.from) <= 0 || bigint(field(h, "count")).Sign() == 0 || !w.accept(h, r.get("6").item(1).owned(0)) {
		return true
	}
	shift := uint(uint32Value(field(h, "shift")))
	width := new(big.Int).Lsh(big.NewInt(1), shift)
	for slot := 0; slot < (1 << w.bitsPerNode); slot++ {
		if bitmap[slot/8]&(1<<(slot%8)) == 0 {
			continue
		}
		start := new(big.Int).Add(base, new(big.Int).Mul(width, big.NewInt(int64(slot))))
		if start.Cmp(w.to) >= 0 || new(big.Int).Add(start, width).Cmp(w.from) <= 0 {
			continue
		}
		at := slots.item(vectorRank(bitmap, uint(slot)))
		if shift == 0 {
			if !checked(w.emit(start, at)) {
				return false
			}
		} else {
			next := at
			if at.typ != 9 {
				e := array(at.owned(0))
				if !w.accept(e[5], field(e[6], "1")) {
					continue
				}
				next = w.basin.load(e)
			}
			if !w.walk(next, start, depth+1) {
				return false
			}
		}
	}
	return true
}
func VisitVector(b *Basin, e Edge, from, to *big.Int, migration int64, accept func(any, any) bool, emit func(*big.Int, Ref) (bool, error)) (err error) {
	defer protect(&err)
	nonnegative(from)
	nonnegative(to)
	require(from.Cmp(to) <= 0, "invalid vector range")
	h := vectorRoot(e, migration)
	if from.Cmp(to) < 0 && from.Cmp(bigint(field(h, "length"))) < 0 && bigint(field(h, "count")).Sign() > 0 && accept(h, field(e[6], "1")) {
		w := vectorWalk{b, from, to, migration, uint32Value(field(h, "bits")), accept, emit}
		w.walk(b.load(e), new(big.Int), 0)
	}
	return nil
}
func VectorEntries(b *Basin, e Edge, migration int64) (rows []VectorEntry, err error) {
	defer protect(&err)
	rows = []VectorEntry{}
	h := vectorRoot(e, migration)
	err = VisitVector(b, e, new(big.Int), bigint(field(h, "length")), migration, func(any, any) bool { return true }, func(i *big.Int, r Ref) (bool, error) {
		rows = append(rows, VectorEntry{i, r.owned(0)})
		return true, nil
	})
	return
}
func UpdateVector(b *Basin, e Edge, changes []VectorChange, length *big.Int, c Consumer) (edge Edge, err error) {
	defer protect(&err)
	nonnegative(length)
	values := map[string]VectorEntry{}
	for _, r := range checked(VectorEntries(b, e, c.Migration)) {
		if r.Index.Cmp(length) < 0 {
			values[r.Index.String()] = r
		}
	}
	for _, r := range changes {
		nonnegative(r.Index)
		require(r.Index.Cmp(length) < 0, "vector index outside length")
		if r.Delete {
			delete(values, r.Index.String())
		} else {
			values[r.Index.String()] = VectorEntry{r.Index, r.Value}
		}
	}
	rows := []VectorEntry{}
	for _, r := range values {
		rows = append(rows, r)
	}
	return BuildVectorEntries(b, length, rows, c, uint(uint32Value(field(vectorRoot(e, c.Migration), "bits"))))
}
