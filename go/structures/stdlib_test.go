package structures

import (
	"bytes"
	"encoding/binary"
	"math/big"
	"reflect"
	"testing"
)

func standardRows(n int) []Entry {
	rows := []Entry{}
	for i := 0; i < n; i++ {
		key := make([]byte, 4)
		binary.BigEndian.PutUint32(key, uint32(i))
		var value any
		if i%7 != 0 {
			value = big.NewInt(int64(i))
		}
		rows = append(rows, Entry{key, value})
	}
	return rows
}
func checkBTreeNode(t *testing.T, b *Basin, node Node, root bool) int {
	t.Helper()
	h := node["5"]
	depth := uint32Value(field(h, "depth"))
	f := array(node["6"])
	keys := array(f[2])
	if len(keys) > 31 || !root && len(keys) < 15 {
		t.Fatal("B-tree occupancy", len(keys))
	}
	for i := 1; i < len(keys); i++ {
		if bytes.Compare(blob(keys[i-1]), blob(keys[i])) >= 0 {
			t.Fatal("unsorted keys")
		}
	}
	count, inline := len(keys), len(keys)
	if depth > 0 {
		children := array(f[4])
		if len(children) != len(keys)+1 {
			t.Fatal("children")
		}
		for _, c := range children {
			n, ok := c.(map[string]any)
			if !ok {
				r, e := b.Load(array(c))
				if e != nil {
					t.Fatal(e)
				}
				n = mapping(r.owned(0))
			} else {
				inline += int(uint32Value(field(n["5"], "inlined")))
			}
			if uint32Value(field(n["5"], "depth")) != depth-1 {
				t.Fatal("depth")
			}
			count += checkBTreeNode(t, b, n, false)
		}
	}
	if bigint(field(h, "count")).Cmp(big.NewInt(int64(count))) != 0 || int(uint32Value(field(h, "inlined"))) != inline {
		t.Fatal("counts")
	}
	return count
}
func TestPackedBTreeAndVector(t *testing.T) {
	for _, n := range structureVectors(t).OrderedCounts {
		b := newTestBasin(t)
		input := standardRows(n)
		root, e := BuildBTree(b, input, CountConsumer(7))
		if e != nil {
			t.Fatal(e)
		}
		r, e := b.Load(root)
		if e != nil {
			t.Fatal(e)
		}
		node := mapping(r.owned(0))
		if checkBTreeNode(t, b, node, true) != n {
			t.Fatal("size")
		}
		entries, e := BTreeEntries(b, root, 7)
		if e != nil || !reflect.DeepEqual(input, entries) {
			t.Fatal("B-tree entries", e)
		}
		if n > 31 {
			k := blob(at(at(node["6"], 2), 0))
			expected := at(at(node["6"], 3), 0)
			b.ClearCache()
			b.Storage.(*MemoryStorage).Reads = 0
			v, ok, e := GetBTree(b, root, k, 7)
			if e != nil || !ok || !reflect.DeepEqual(v, expected) || b.Storage.(*MemoryStorage).Reads != 1 {
				t.Fatal("separator", e)
			}
		}
		if n > 0 {
			next, e := UpdateBTree(b, root, []Change{{Key: input[0].Key, Delete: true}}, CountConsumer(7))
			if e != nil {
				t.Fatal(e)
			}
			fresh, e := BuildBTree(b, input[1:], CountConsumer(7))
			if e != nil || !reflect.DeepEqual(next, fresh) {
				t.Fatal("collapse", e)
			}
		}
		values := []any{}
		for _, r := range input {
			values = append(values, r.Value)
		}
		vroot, e := BuildVector(b, values, CountConsumer(7))
		if e != nil {
			t.Fatal(e)
		}
		ve, e := VectorEntries(b, vroot, 7)
		if e != nil || len(ve) != n {
			t.Fatal("vector entries", e)
		}
		for i, r := range ve {
			if r.Index.Cmp(big.NewInt(int64(i))) != 0 || !reflect.DeepEqual(r.Value, values[i]) {
				t.Fatal("vector order")
			}
		}
		for _, i := range []int{0, 31, 32, 1023} {
			if i >= n {
				continue
			}
			v, ok, e := GetVector(b, vroot, big.NewInt(int64(i)), 7)
			if e != nil || !ok || !reflect.DeepEqual(v, values[i]) {
				t.Fatal("vector get", e)
			}
		}
		if n > 0 {
			next, e := UpdateVector(b, vroot, []VectorChange{{Index: new(big.Int), Value: "changed"}}, big.NewInt(int64(n)), CountConsumer(7))
			if e != nil {
				t.Fatal(e)
			}
			v, ok, e := GetVector(b, next, new(big.Int), 7)
			if e != nil || !ok || v != "changed" {
				t.Fatal("vector update", e)
			}
		}
	}
}
func TestSparseVectorAndAggregatePruning(t *testing.T) {
	b := newTestBasin(t)
	far := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 200), big.NewInt(31))
	length := new(big.Int).Add(far, big.NewInt(1))
	root, e := BuildVectorEntries(b, length, []VectorEntry{{new(big.Int), nil}, {big.NewInt(31), "slot31"}, {far, "far"}}, CountConsumer(7))
	if e != nil {
		t.Fatal(e)
	}
	v, ok, e := GetVector(b, root, far, 7)
	if e != nil || !ok || v != "far" {
		t.Fatal(e)
	}
	_, ok, e = GetVector(b, root, big.NewInt(1), 7)
	if e != nil || ok {
		t.Fatal("hole", e)
	}
	next, e := UpdateVector(b, root, nil, big.NewInt(32), CountConsumer(7))
	if e != nil {
		t.Fatal(e)
	}
	v, ok, e = GetVector(b, next, big.NewInt(31), 7)
	if e != nil || !ok || v != "slot31" {
		t.Fatal("truncate", e)
	}
	b.ClearCache()
	b.Storage.(*MemoryStorage).Reads = 0
	e = VisitVector(b, root, new(big.Int), length, 7, func(any, any) bool { return false }, func(*big.Int, Ref) (bool, error) { t.Fatal("unpruned"); return false, nil })
	if e != nil || b.Storage.(*MemoryStorage).Reads != 0 {
		t.Fatal("vector prune", e)
	}
}

func TestMalformedStructuralMapsAreNotVectors(t *testing.T) {
	b := newTestBasin(t)
	root, e := BuildVector(b, []any{[]byte{1, 2, 3}}, CountConsumer(7))
	if e != nil {
		t.Fatal(e)
	}
	view, e := GetVectorView(b, root, new(big.Int), 7)
	if e != nil {
		t.Fatal(e)
	}
	b.ClearCache()
	if got, e := view.Blob(); e != nil || !bytes.Equal(got, []byte{1, 2, 3}) {
		t.Fatal("view lifetime", e)
	}
	r, e := b.Load(root)
	if e != nil {
		t.Fatal(e)
	}
	n := mapping(r.owned(0))
	array(n["6"])[3] = map[string]any{"slot": []byte{1, 2, 3}}
	bad, e := b.Seal(n, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = GetVector(b, bad, new(big.Int), 7); e == nil {
		t.Fatal("map accepted as vector")
	}
	root, e = BuildBTree(b, []Entry{{[]byte{0xaa}, nil}}, CountConsumer(7))
	if e != nil {
		t.Fatal(e)
	}
	r, e = b.Load(root)
	if e != nil {
		t.Fatal(e)
	}
	n = mapping(r.owned(0))
	array(n["6"])[2] = map[string]any{"key": []byte{0xaa}}
	bad, e = b.Seal(n, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = GetBTree(b, bad, []byte{0xaa}, 7); e == nil {
		t.Fatal("map accepted as keys vector")
	}
}

func TestConsumerVectorWidthSurvivesUpdates(t *testing.T) {
	for width := uint(1); width <= 8; width++ {
		b := newTestBasin(t)
		last := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 200), big.NewInt((1<<width)-1))
		length := new(big.Int).Add(last, big.NewInt(1))
		root, err := BuildVectorEntries(b, length, []VectorEntry{{big.NewInt(0), nil}, {big.NewInt((1 << width) - 1), Symbol{Name: "match"}}, {last, int64(42)}}, CountConsumer(7), width)
		if err != nil {
			t.Fatal(err)
		}
		next, err := UpdateVector(b, root, []VectorChange{{Index: last, Value: int64(43)}}, length, CountConsumer(7))
		if err != nil {
			t.Fatal(err)
		}
		if uint(integer(field(next[5], "bits"))) != width {
			t.Fatal("lost width")
		}
		for _, p := range []struct {
			root Edge
			want int64
		}{{root, 42}, {next, 43}} {
			v, found, err := GetVector(b, p.root, last, 7)
			if err != nil || !found || v != p.want {
				t.Fatalf("value %v %v %v", v, found, err)
			}
		}
	}
}

func TestPageBoundarySpines(t *testing.T) {
	b := newTestBasin(t)
	rows := make([]PageInput, 20000)
	for i := range rows {
		rows[i] = PageInput{big.NewInt(int64(i)), []byte{byte(i)}}
	}
	block, err := BuildBlock(b, rows)
	if err != nil {
		t.Fatal(err)
	}
	footer := field(b.load(block.Edge).owned(0), "6")
	for _, i := range []int{3, 4} {
		for h, hint := range array(at(footer, i)) {
			if hint != nil && integer(field(field(hint, "link"), "height")) != int64(h) {
				t.Fatal("height index")
			}
		}
	}
}
