package structures

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"sort"
)

const Domain = "sync.memoremix.com"

type Edge = []any
type Node = map[string]any

// PendingEdge cannot be embedded until storage supplies its allocation revision.
type PendingEdge struct{ value Edge }

func (p PendingEdge) Value() Edge { return p.value }
func (p PendingEdge) Allocated(revision string) (e Edge, err error) {
	defer protect(&err)
	require(validRevision(revision), "invalid node revision")
	e = append(Edge{}, p.value...)
	f := map[string]any{}
	for k, v := range mapping(e[6]) {
		f[k] = v
	}
	f["revision"] = revision
	e[6] = f
	return e, nil
}

var revisionPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validRevision(s string) bool { return revisionPattern.MatchString(s) }

func digest(b []byte) []byte { d := sha512.Sum384(b); return d[:] }
func mac(secret, b []byte) []byte {
	h := hmac.New(sha512.New384, secret)
	h.Write(b)
	return h.Sum(nil)
}
func frame(message []byte) []byte {
	require(uint64(len(message)) <= 0xffffffff, "node exceeds u32 length")
	end := (len(message) + 23) / 8 * 8
	b := make([]byte, end)
	copy(b, []byte{'e', 'n', 'V', 0xa3})
	binary.LittleEndian.PutUint32(b[4:], uint32(len(message)))
	copy(b[8:], message)
	for i := 8 + len(message); i < end-8; i++ {
		b[i] = 0xee
	}
	binary.LittleEndian.PutUint32(b[end-8:], uint32(len(message)))
	copy(b[end-4:], []byte{0xa3, 'v', 'N', 'E'})
	return b
}
func unframe(b []byte) []byte {
	require(len(b) >= 16, "truncated node")
	n := uint64(binary.LittleEndian.Uint32(b[4:8]))
	end := (n + 23) / 8 * 8
	require(end == uint64(len(b)) && bytes.Equal(b[:4], []byte{'e', 'n', 'V', 0xa3}) && binary.LittleEndian.Uint32(b[len(b)-8:]) == uint32(n) && bytes.Equal(b[len(b)-4:], []byte{0xa3, 'v', 'N', 'E'}), "invalid node envelope")
	for _, v := range b[8+int(n) : len(b)-8] {
		require(v == 0xee, "invalid node padding")
	}
	return b[8 : 8+int(n)]
}
func validateNode(r Ref, path string) {
	require(r.typ == 9, "node must be a map")
	require(reflect.DeepEqual(r.get("0").owned(0), Symbol{Name: "species"}) && r.get("1").str() != "" && uint32Value(r.get("4").owned(0)) == 0, "unsupported node schema")
	if path != "" {
		require(r.get("1").str() == Domain && r.get("2").str() == path, "wrong node species")
	}
}
func validateEdge(e Edge) {
	validatePending(e)
	require(validRevision(text(field(e[6], "revision"))), "invalid node revision")
}
func validatePending(e Edge) {
	require(len(e) == 7 && reflect.DeepEqual(e[0], Symbol{Name: "match"}) && text(e[1]) != "" && uint32Value(e[4]) == 0, "unsupported edge schema")
	f := mapping(e[6])
	require(uint32Value(f["version"]) == 0 && len(blob(f["sha384"])) == 48 && len(blob(f["entropy"])) == 32, "invalid edge descriptor")
	uint32Value(field(e[3], "height"))
	uint32Value(f["length"])
}
func authKey(e Edge) string {
	return fmt.Sprintf("%d/%d/%x", uint32Value(field(e[3], "height")), uint32Value(field(e[6], "version")), blob(field(e[6], "entropy")))
}
func capability(e Edge) string { return authKey(e) + "/" + text(field(e[6], "revision")) }
func weak(e Edge) any {
	return map[string]any{"height": field(e[3], "height"), "version": field(e[6], "version"), "entropy": field(e[6], "entropy"), "revision": field(e[6], "revision")}
}
func weakKey(link any) string {
	return fmt.Sprintf("%d/%d/%x/%s", uint32Value(field(link, "height")), uint32Value(field(link, "version")), blob(field(link, "entropy")), text(field(link, "revision")))
}
func Derive(e Edge) (token, secret, nonce []byte, err error) {
	defer protect(&err)
	validatePending(e)
	prk := mac(make([]byte, 48), blob(field(e[6], "entropy")))
	part := func(label string, n int) []byte {
		return mac(prk, append([]byte("basinsync/basin-node/0/"+label), 1))[:n]
	}
	return part("token", 32), part("secret", 32), part("nonce", 12), nil
}
func distinct(edges []Edge) []Edge {
	m := map[string]Edge{}
	for _, e := range edges {
		validateEdge(e)
		k := authKey(e)
		if old, ok := m[k]; ok {
			require(bytes.Equal(blob(field(old[6], "sha384")), blob(field(e[6], "sha384"))) && field(old[6], "revision") == field(e[6], "revision"), "conflicting edge descriptor")
		}
		m[k] = e
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	out := make([]Edge, 0, len(m))
	for _, k := range names {
		out = append(out, m[k])
	}
	return out
}
func emptyQuery() map[string]any {
	return map[string]any{"height": int64(0), "degree": int64(0), "breadth": new(big.Int), "rotations": nil, "versions": nil, "schemas": nil, "migrations": nil}
}
func query(edges []Edge, maxDegree, maxHeight int) map[string]any {
	refs := distinct(edges)
	require(len(refs) <= maxDegree, "basin degree limit")
	q := emptyQuery()
	if len(refs) == 0 {
		return q
	}
	height := int64(0)
	breadth := big.NewInt(int64(len(refs)))
	ranges := map[string][]uint32{"rotations": {}, "versions": {}, "schemas": {}, "migrations": {}}
	for _, e := range refs {
		h := int64(uint32Value(field(e[3], "height"))) + 1
		if h > height {
			height = h
		}
		breadth.Add(breadth, bigint(field(e[3], "breadth")))
		for name, own := range map[string]any{"rotations": field(e[6], "rotation"), "versions": field(e[6], "version"), "schemas": e[4], "migrations": field(e[6], "0")} {
			ranges[name] = append(ranges[name], uint32Value(own))
			if r := field(e[3], name); r != nil {
				a := array(r)
				require(len(a) == 2, "invalid range")
				ranges[name] = append(ranges[name], uint32Value(a[0]), uint32Value(a[1]))
			}
		}
	}
	require(height <= int64(maxHeight), "basin height limit")
	q["height"] = height
	q["degree"] = int64(len(refs))
	q["breadth"] = breadth
	for name, vs := range ranges {
		lo, hi := vs[0], vs[0]
		for _, n := range vs {
			if n < lo {
				lo = n
			}
			if n > hi {
				hi = n
			}
		}
		q[name] = vector(int64(lo), int64(hi))
	}
	return q
}

type Storage interface {
	Put(PendingEdge, []byte, []Edge) (string, error)
	Get(Edge) ([]byte, error)
}
type Resolver interface{ Resolve(any) (Edge, error) }
type Stored struct {
	Edge  Edge
	Bytes []byte
	Edges []Edge
}
type MemoryStorage struct {
	Objects      map[string]Stored
	Capabilities map[string]Edge
	Reads        int
	nextRevision uint64
}

func NewMemoryStorage() *MemoryStorage {
	return &MemoryStorage{Objects: map[string]Stored{}, Capabilities: map[string]Edge{}}
}
func (m *MemoryStorage) Restore(e Edge, b []byte, edges []Edge) (err error) {
	defer protect(&err)
	validateEdge(e)
	key := capability(e)
	if old, ok := m.Objects[key]; ok {
		require(bytes.Equal(old.Bytes, b), "immutable storage conflict")
	}
	m.Objects[key] = Stored{e, append([]byte{}, b...), append([]Edge{}, edges...)}
	m.Capabilities[key] = e
	return nil
}
func (m *MemoryStorage) Put(p PendingEdge, b []byte, edges []Edge) (revision string, err error) {
	defer protect(&err)
	auth := authKey(p.value)
	for _, old := range m.Objects {
		if authKey(old.Edge) == auth {
			require(bytes.Equal(old.Bytes, b), "immutable storage conflict")
			return text(field(old.Edge[6], "revision")), nil
		}
	}
	// Predictable UUIDv4-shaped identities are for this in-memory test store only.
	for {
		m.nextRevision++
		revision = fmt.Sprintf("00000000-0000-4000-8000-%012x", m.nextRevision)
		if _, ok := m.Capabilities[auth+"/"+revision]; !ok {
			break
		}
	}
	e := checked(p.Allocated(revision))
	checked(0, m.Restore(e, b, edges))
	return revision, nil
}
func (m *MemoryStorage) Get(e Edge) (b []byte, err error) {
	defer protect(&err)
	m.Reads++
	stored, ok := m.Objects[capability(e)]
	require(ok, "missing basin node")
	return append([]byte{}, stored.Bytes...), nil
}
func (m *MemoryStorage) Resolve(link any) (e Edge, err error) {
	defer protect(&err)
	return m.Capabilities[weakKey(link)], nil
}

type Basin struct {
	Storage                        Storage
	Seed                           []byte
	Rotation                       int64
	MaxDegree, MaxHeight, MaxBytes int
	MaxCacheBytes                  int
	cacheOrder                     []string
	cacheBytes                     int
	cache                          map[string][]byte
}

func NewBasin(storage Storage, seed []byte) (b *Basin, err error) {
	defer protect(&err)
	require(len(seed) >= 32, "seed requires 256 secret bits")
	return &Basin{Storage: storage, Seed: append([]byte{}, seed...), MaxDegree: 320, MaxHeight: 128, MaxBytes: 64 * 1024 * 1024, MaxCacheBytes: 16 * 1024 * 1024, cache: map[string][]byte{}}, nil
}
func (b *Basin) seal(node Node, edges []Edge) Edge {
	refs := distinct(edges)
	node["3"] = query(refs, b.MaxDegree, b.MaxHeight)
	data := frame(checked(Encode(node)))
	require(len(data) <= b.MaxBytes, "basin node byte limit")
	sha := digest(data)
	entropy := mac(b.Seed, append([]byte("basinsync/basin-node/entropy/0"), sha...))[:32]
	weight := big.NewInt(int64(len(data)))
	for _, e := range refs {
		weight.Add(weight, bigint(field(e[6], "weight")))
	}
	footer := array(node["6"])
	e := Edge{Symbol{Name: "match"}, node["1"], node["2"], node["3"], node["4"], node["5"], map[string]any{"0": footer[0], "1": footer[1], "version": int64(0), "length": int64(len(data)), "weight": weight, "sha384": sha, "entropy": entropy, "rotation": b.Rotation}}
	pending := PendingEdge{e}
	revision := checked(b.Storage.Put(pending, data, refs))
	return checked(pending.Allocated(revision))
}
func (b *Basin) Seal(node Node, edges []Edge) (e Edge, err error) {
	defer protect(&err)
	return b.seal(node, edges), nil
}
func (b *Basin) load(e Edge) Ref {
	validateEdge(e)
	sha := blob(field(e[6], "sha384"))
	k := capability(e) + "/" + hex.EncodeToString(sha)
	data, ok := b.cache[k]
	if !ok {
		data = checked(b.Storage.Get(e))
		require(len(data) == int(uint32Value(field(e[6], "length"))) && bytes.Equal(digest(data), sha), "basin node digest/length mismatch")
		if len(data) <= b.MaxCacheBytes {
			for len(b.cacheOrder) > 0 && (len(b.cache) >= 128 || b.cacheBytes+len(data) > b.MaxCacheBytes) {
				old := b.cacheOrder[0]
				b.cacheOrder = b.cacheOrder[1:]
				b.cacheBytes -= len(b.cache[old])
				delete(b.cache, old)
			}
			b.cache[k] = data
			b.cacheOrder = append(b.cacheOrder, k)
			b.cacheBytes += len(data)
		}
	}
	r := rootRef(unframe(data))
	validateNode(r, "")
	for i := 1; i <= 5; i++ {
		require(r.get(strconvIndex(i)).matches(e[i], 0), "edge summary mismatch")
	}
	f := r.get("6")
	require(f.item(0).matches(field(e[6], "0"), 0) && f.item(1).matches(field(e[6], "1"), 0), "edge summary mismatch")
	return r
}
func strconvIndex(i int) string                 { return string(rune('0' + i)) }
func (b *Basin) Load(e Edge) (r Ref, err error) { defer protect(&err); return b.load(e), nil }
func (b *Basin) peek(e Edge) *Ref {
	validateEdge(e)
	k := capability(e) + "/" + hex.EncodeToString(blob(field(e[6], "sha384")))
	if _, ok := b.cache[k]; !ok {
		return nil
	}
	r := b.load(e)
	return &r
}

// Peek validates cached descriptors without a storage GET.
func (b *Basin) Peek(e Edge) (r *Ref, err error) { defer protect(&err); return b.peek(e), nil }
func (b *Basin) ClearCache()                     { b.cache = map[string][]byte{}; b.cacheOrder = nil; b.cacheBytes = 0 }

// NodeKey resolves shared-heap addresses; the adapter supplies bucket/tenant prefix.
func NodeKey(link any, generation string) (key string, err error) {
	defer protect(&err)
	require(generation == "young" || generation == "old", "invalid generation")
	height, version := uint32Value(field(link, "height")), uint32Value(field(link, "version"))
	revision, entropy := text(field(link, "revision")), blob(field(link, "entropy"))
	require(version == 0 && validRevision(revision) && len(entropy) == 32, "invalid node pointer")
	token := mac(mac(make([]byte, 48), entropy), append([]byte("basinsync/basin-node/0/token"), 1))[:32]
	lex := func(n uint32, negative bool) string {
		h := fmt.Sprintf("%x", n)
		size := byte(len(h) - 1)
		if !negative {
			return "0z" + string('g'+size) + h
		}
		body := []byte(h)
		for i, c := range body {
			var v byte
			if c <= '9' {
				v = c - '0'
			} else {
				v = c - 'a' + 10
			}
			body[i] = "fedcba9876543210"[v]
		}
		return "0y" + string('v'-size) + string(body)
	}
	return fmt.Sprintf("userspace/heap/%s/n-%s/v.%s/t.%s/d_%x/%s", generation, lex(height, true), lex(version, false), lex(uint32(len(token)), false), digest(token), revision), nil
}
