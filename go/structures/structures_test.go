package structures

import (
	"bytes"
	"encoding/hex"
	"math"
	"math/big"
	"reflect"
	"testing"
)

func newTestBasin(t *testing.T) *Basin {
	t.Helper()
	b, err := NewBasin(NewMemoryStorage(), bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func rows(n int) []Entry {
	v := make([]Entry, n)
	for i := range v {
		var value any
		if i%7 != 0 {
			value = map[string]any{"n": big.NewInt(int64(i)), "data": []byte{byte(i)}}
		}
		v[i] = Entry{[]byte{byte(i >> 8), byte(i)}, value}
	}
	return v
}
func TestCodecAndPublishedSL2(t *testing.T) {
	expected := "01c5cf590d32654c87228c0d66441b200aec1439e54e724f05cd3c6c260634e565594b61988933e826e9705de22884ce007df0f733a371516ddd4ac9237f7a46"
	if hex.EncodeToString(Bromberg([]byte("hello, world! It's fun to hash stuff!"))) != expected {
		t.Fatal("independent hash vector")
	}
	if !bytes.Equal(combineSL([][]byte{Bromberg([]byte("hello, ")), Bromberg([]byte("world!"))}), Bromberg([]byte("hello, world!"))) {
		t.Fatal("composition")
	}
	values := []any{nil, true, int64(-123), 0.5, "", []byte{}, new(big.Int).Lsh(big.NewInt(1), 1000), new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 1000)), Symbol{Name: "match"}, Symbol{Name: "x", Global: true}, vector(true, false), vector("a", "b"), map[string]any{"\uffff": int64(1), "\U00010000": int64(2)}}
	for _, value := range values {
		b, err := Encode(value)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := Decode(b)
		if err != nil || !reflect.DeepEqual(value, decoded) {
			t.Fatalf("roundtrip %T: %v", value, err)
		}
	}
}
func TestCanonicalBoundaries(t *testing.T) {
	for _, n := range []int{0, 1, 63, 64, 255, 256, 1280, 1281, 5000} {
		b := newTestBasin(t)
		input := rows(n)
		root, err := Build(b, input, CountConsumer(7))
		if err != nil {
			t.Fatal(n, err)
		}
		if _, exists := mapping(root[5])["reversals"]; exists {
			t.Fatal("base header has reversal bounds")
		}
		reversed := append([]Entry{}, input...)
		for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
			reversed[i], reversed[j] = reversed[j], reversed[i]
		}
		same, err := Build(b, reversed, CountConsumer(7))
		if err != nil || !reflect.DeepEqual(root, same) {
			t.Fatal("insertion history", n, err)
		}
		all, err := Entries(b, root, nil, 7)
		if err != nil || !reflect.DeepEqual(all, input) {
			t.Fatal("scan", n, err)
		}
		for _, i := range []int{0, 62, 63, 254, 255, 1279, n - 1} {
			if i >= 0 && i < n {
				v, ok, err := Get(b, root, input[i].Key, 7)
				if err != nil || !ok || !reflect.DeepEqual(v, input[i].Value) {
					t.Fatal("lookup", n, i, err)
				}
			}
		}
		b.ClearCache()
		b.Storage.(*MemoryStorage).Reads = 0
		err = Visit(b, root, nil, 7, func(any, any) bool { return false }, func([]byte, Ref) (bool, error) { t.Fatal("pruned"); return false, nil })
		if err != nil || b.Storage.(*MemoryStorage).Reads != 0 {
			t.Fatal("pruning", err)
		}
	}
}
func TestCollapseAndCorruption(t *testing.T) {
	b := newTestBasin(t)
	root, err := Build(b, rows(2000), CountConsumer(7))
	if err != nil {
		t.Fatal(err)
	}
	updated, err := Update(b, root, []Change{{Key: []byte{7, 207}, Delete: true}}, CountConsumer(7))
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := Build(b, rows(1999), CountConsumer(7))
	if err != nil || !reflect.DeepEqual(updated, fresh) {
		t.Fatal("collapse", err)
	}
	empty, err := Build(b, nil, CountConsumer(7))
	if err != nil {
		t.Fatal(err)
	}
	one, err := Build(b, []Entry{{[]byte{}, nil}}, CountConsumer(7))
	if err != nil || reflect.DeepEqual(empty, one) {
		t.Fatal("empty key", err)
	}
	value, ok, err := Get(b, one, nil, 7)
	if err != nil || !ok || value != nil {
		t.Fatal("null value", err)
	}
	b.ClearCache()
	s := b.Storage.(*MemoryStorage)
	k := capability(root)
	stored := s.Objects[k]
	stored.Bytes = append([]byte{}, stored.Bytes...)
	stored.Bytes[8] ^= 1
	s.Objects[k] = stored
	if _, err = b.Load(root); err == nil {
		t.Fatal("corrupt object accepted")
	}
}
func TestVolumeSnapshotsAndShortcuts(t *testing.T) {
	b := newTestBasin(t)
	large := make([]byte, 8195)
	for i := range large {
		large[i] = byte(i)
	}
	files := []FileInput{{"/a", large}, {"/dir/empty", []byte{}}, {"/dir/__proto__", []byte("safe")}, {"/\uffff", []byte("bmp")}, {"/\U00010000", []byte("astral")}}
	root, err := BuildVolume(b, files)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		for _, weak := range []bool{true, false} {
			got, err := ReadFile(b, root, f.Path, weak)
			if err != nil || !bytes.Equal(got, f.Bytes) {
				t.Fatal("file", f.Path, err)
			}
		}
	}
	b.Storage.(*MemoryStorage).Capabilities = map[string]Edge{}
	if got, err := ReadFile(b, root, "/a", true); err != nil || !bytes.Equal(got, large) {
		t.Fatal("weak miss", err)
	}
	updated, err := UpdateVolume(b, root, []FileChange{{Path: "/a", Delete: true}, {Path: "/b", Bytes: large}})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := ReadFile(b, updated, "/b", false); err != nil || !bytes.Equal(got, large) {
		t.Fatal(err)
	}
	if got, err := ReadFile(b, root, "/a", true); err != nil || !bytes.Equal(got, large) {
		t.Fatal("old snapshot", err)
	}
}
func FuzzDecode(f *testing.F) {
	for _, v := range []any{nil, int64(4), []byte{}, vector(Symbol{Name: "match"}, map[string]any{"a": big.NewInt(0)}), map[string]any{"0": Symbol{Name: "species"}}} {
		b, _ := Encode(v)
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 65536 {
			t.Skip()
		}
		_, _ = Decode(b)
	})
}
func TestPartialReadsAndMigrations(t *testing.T) {
	b := newTestBasin(t)
	data := make([]byte, PageSize*1281+13)
	for i := range data {
		data[i] = byte(i)
	}
	root, err := BuildVolume(b, []FileInput{{"/large", data}})
	if err != nil {
		t.Fatal(err)
	}
	b.ClearCache()
	b.Storage.(*MemoryStorage).Reads = 0
	got, err := ReadRange(b, root, "/large", 3, 17, true)
	if err != nil || !bytes.Equal(got, data[3:20]) || b.Storage.(*MemoryStorage).Reads > 3 {
		t.Fatal("partial read", err)
	}
	got, err = ReadRange(b, root, "/large", uint64(len(data)-5), 40, true)
	if err != nil || !bytes.Equal(got, data[len(data)-5:]) {
		t.Fatal("EOF", err)
	}
	got, err = ReadRange(b, root, "/large", uint64(len(data)+10), 4, true)
	if err != nil || len(got) != 0 {
		t.Fatal("past EOF", err)
	}
	b.Storage.(*MemoryStorage).Capabilities = map[string]Edge{}
	got, err = ReadRange(b, root, "/large", 3, 17, true)
	if err != nil || !bytes.Equal(got, data[3:20]) {
		t.Fatal("shortcut miss", err)
	}
	old, err := Build(b, rows(1400), CountConsumer(7))
	if err != nil {
		t.Fatal(err)
	}
	all, err := Entries(b, old, nil, 7)
	if err != nil {
		t.Fatal(err)
	}
	for i := range all {
		all[i].Value = map[string]any{"old": all[i].Value}
	}
	next, err := Build(b, all, CountConsumer(8))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = Get(b, next, []byte{0, 1}, 7); err == nil {
		t.Fatal("unsupported migration")
	}
	if v, ok, err := Get(b, next, []byte{0, 1}, 8); err != nil || !ok || !reflect.DeepEqual(v, map[string]any{"old": rows(2)[1].Value}) {
		t.Fatal("migration", err)
	}
}
func TestEmptyDirectoriesSurviveUpdates(t *testing.T) {
	b := newTestBasin(t)
	root, err := BuildVolume(b, []FileInput{{"/kept/file", []byte("x")}}, "/empty", "/deep/empty")
	if err != nil {
		t.Fatal(err)
	}
	names, err := List(b, root, "/empty")
	if err != nil || len(names) != 0 {
		t.Fatal(err)
	}
	next, err := UpdateVolume(b, root, []FileChange{{Path: "/kept/file", Delete: true}})
	if err != nil {
		t.Fatal(err)
	}
	names, err = List(b, next, "/kept")
	if err != nil || len(names) != 0 {
		t.Fatal(err)
	}
}

func TestRevisionsPinAllocationsAndSharedHeapAddresses(t *testing.T) {
	b := newTestBasin(t)
	first, err := Build(b, rows(1), PlainConsumer())
	if err != nil {
		t.Fatal(err)
	}
	pointer := weak(first)
	token, _, _, err := Derive(first)
	if err != nil {
		t.Fatal(err)
	}
	key, err := NodeKey(pointer, "old")
	if err != nil {
		t.Fatal(err)
	}
	expected := "userspace/heap/old/n-0yvf/v.0zg0/t.0zh20/d_" + hex.EncodeToString(digest(token)) + "/" + text(field(first[6], "revision"))
	if key != expected {
		t.Fatal(key, expected)
	}
	delete(b.Storage.(*MemoryStorage).Objects, capability(first))
	second, err := Build(b, rows(1), PlainConsumer())
	if err != nil {
		t.Fatal(err)
	}
	if field(first[6], "revision") == field(second[6], "revision") {
		t.Fatal("reused stale revision")
	}
	b.ClearCache()
	if _, err = b.Load(first); err == nil {
		t.Fatal("stale allocation was readable")
	}
	if _, err = b.Load(second); err != nil {
		t.Fatal(err)
	}
}

func TestBorrowedMetadataMatchesJSON0Comparisons(t *testing.T) {
	values := []any{nil, true, int64(1), 1.0, 1.5, math.Copysign(0, -1), "0literal", []byte{}, []byte{1, 2}, new(big.Int).Lsh(big.NewInt(1), 200), Symbol{Name: "match"}, Symbol{Name: "shared", Global: true}}
	values = append(values, append([]any{}, values...))
	values = append(values, map[string]any{"__proto__": "safe", "values": append([]any{}, values...)})
	for _, actual := range values {
		data, e := Encode(actual)
		if e != nil {
			t.Fatal(e)
		}
		r := rootRef(data)
		owned := r.owned(0)
		for _, expected := range values {
			a, e := JSON0(owned)
			if e != nil {
				t.Fatal(e)
			}
			b, e := JSON0(expected)
			if e != nil {
				t.Fatal(e)
			}
			if r.matches(expected, 0) != bytes.Equal(a, b) {
				t.Fatalf("comparison differs: %s vs %s", a, b)
			}
		}
	}
}

func TestVolumeFilesystemEditsRetainBlocksAndRehashDirectories(t *testing.T) {
	b := newTestBasin(t)
	block, err := BuildBlock(b, []PageInput{{big.NewInt(0), []byte("one")}})
	if err != nil {
		t.Fatal(err)
	}
	root, err := VolumeFromBlocks(b, map[string]BlockRoot{"/src/file": block, "/src2/file": block}, "/src/empty", "/out")
	if err != nil {
		t.Fatal(err)
	}
	storage := b.Storage.(*MemoryStorage)
	key := capability(block.Edge)
	saved := storage.Objects[key]
	delete(storage.Objects, key)
	b.ClearCache()
	moved, err := MoveVolume(b, root, "/src", "/out/moved", false)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := CopyVolume(b, moved, "/out/moved", "/copy", false)
	if err != nil {
		t.Fatal(err)
	}
	final, err := RemoveVolume(b, copied, "/out/moved", true)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := VolumeFromBlocks(b, map[string]BlockRoot{"/copy/file": block, "/src2/file": block}, "/copy/empty", "/out")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(blob(field(final[6], "sha384")), blob(field(canonical[6], "sha384"))) {
		t.Fatal("canonical hash")
	}
	for _, f := range []func() error{
		func() error { _, e := RemoveVolume(b, root, "/src", false); return e },
		func() error { _, e := MoveVolume(b, root, "/src", "/src/child", false); return e },
		func() error { _, e := MoveVolume(b, root, "/missing", "/missing", false); return e },
		func() error { _, e := CopyVolume(b, root, "/src", "/src", true); return e },
		func() error { _, e := MoveVolume(b, root, "/src", "/src2", true); return e },
		func() error { _, e := MoveVolume(b, root, "/src/file", "/src2", true); return e },
	} {
		if f() == nil {
			t.Fatal("expected rejection")
		}
	}
	if names, e := List(b, final, "/copy/empty"); e != nil || len(names) != 0 {
		t.Fatal(names, e)
	}
	storage.Objects[key] = saved
	if data, e := ReadFile(b, final, "/copy/file", true); e != nil || string(data) != "one" {
		t.Fatal(string(data), e)
	}
}
