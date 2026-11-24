package structures

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"sort"
)

const TriePath = ".trie-node/"

type Consumer struct {
	Migration       int64
	Empty           any
	Entry           func([]byte, any) (any, error)
	Combine         func([]any) (any, error)
	Edges           func(any) ([]Edge, error)
	TrieInlineCost  func(any) int
	TrieExternalize func(*Basin, any) any
}

func PlainConsumer() Consumer {
	return Consumer{Entry: func([]byte, any) (any, error) { return nil, nil }, Combine: func([]any) (any, error) { return nil, nil }}
}
func CountConsumer(migration int64) Consumer {
	return Consumer{Migration: migration, Empty: new(big.Int), Entry: func([]byte, any) (any, error) { return big.NewInt(1), nil }, Combine: func(v []any) (any, error) {
		sum := new(big.Int)
		for _, p := range v {
			sum.Add(sum, bigint(p))
		}
		return sum, nil
	}}
}

type Entry struct {
	Key   []byte
	Value any
}
type row struct {
	key            []byte
	value, summary any
}
type Built struct {
	Node  Node
	Edges []Edge
}
type child struct {
	local *Built
	edge  Edge
}
type member struct {
	group []row
	nodes []*child
}

func trimMembers(v []*member) []*member {
	for len(v) > 0 && v[len(v)-1] == nil {
		v = v[:len(v)-1]
	}
	return v
}
func trimChildren(v []*child) []*child {
	for len(v) > 0 && v[len(v)-1] == nil {
		v = v[:len(v)-1]
	}
	return v
}
func group(rows []row) any {
	keys, values := make([]any, len(rows)), make([]any, len(rows))
	for i, r := range rows {
		keys[i] = append([]byte{}, r.key...)
		values[i] = r.value
	}
	return map[string]any{"keys": keys, "values": values}
}
func bounds(keys [][]byte) any {
	if len(keys) == 0 {
		return nil
	}
	lo, hi := keys[0], keys[0]
	for _, k := range keys {
		if bytes.Compare(k, lo) < 0 {
			lo = k
		}
		if bytes.Compare(k, hi) > 0 {
			hi = k
		}
	}
	return vector(append([]byte{}, lo...), append([]byte{}, hi...))
}
func refs(own []row, members []*member, c Consumer) []Edge {
	out := []Edge{}
	add := func(rows []row) {
		if c.Edges != nil {
			for _, r := range rows {
				out = append(out, checked(c.Edges(r.value))...)
			}
		}
	}
	add(own)
	for _, m := range members {
		if m == nil {
			continue
		}
		if m.nodes == nil {
			add(m.group)
		} else {
			for _, ch := range m.nodes {
				if ch != nil {
					if ch.local != nil {
						out = append(out, ch.local.Edges...)
					} else {
						out = append(out, ch.edge)
					}
				}
			}
		}
	}
	return distinct(out)
}
func rowCost(rows []row, c Consumer) int {
	if c.TrieInlineCost == nil {
		return len(rows)
	}
	n := 0
	for _, r := range rows {
		v := 1
		if c.TrieInlineCost != nil {
			v = c.TrieInlineCost(r.value)
		}
		require(v >= 1 && v <= 1280, "invalid trie inline cost")
		n += v
	}
	return n
}
func inlined(own []row, members []*member, c Consumer) int {
	n := rowCost(own, c)
	for _, m := range members {
		if m == nil {
			continue
		}
		if m.nodes == nil {
			n += rowCost(m.group, c)
		} else {
			for _, ch := range m.nodes {
				if ch != nil && ch.local != nil {
					n += int(uint32Value(field(ch.local.Node["5"], "inlined")))
				}
			}
		}
	}
	return n
}
func split(b *Basin, rows []row, c Consumer, depth int) []*child {
	nodes := make([]*child, 16)
	for low := 0; low < 16; low++ {
		part := []row{}
		for _, r := range rows {
			if int(r.key[0]&15) == low {
				part = append(part, row{key: append([]byte{}, r.key[1:]...), value: r.value, summary: r.summary})
			}
		}
		if len(part) > 0 {
			n := buildRows(b, part, c, depth+1)
			nodes[low] = &child{local: &n}
		}
	}
	return trimChildren(nodes)
}
func buildRows(b *Basin, input []row, c Consumer, depth int) Built {
	require(depth < 256, "trie nesting limit")
	p := 0
	if len(input) > 0 {
		p = len(input[0].key)
	}
	for _, r := range input {
		if len(r.key) < p {
			p = len(r.key)
		}
		for i := 0; i < p; i++ {
			if r.key[i] != input[0].key[i] {
				p = i
				break
			}
		}
	}
	var prefix any
	if p > 0 {
		prefix = append([]byte{}, input[0].key[:p]...)
	}
	rows := make([]row, len(input))
	summaries := make([]any, len(input))
	keys := make([][]byte, len(input))
	minLen, maxLen, nullity := 0, 0, 0
	if len(input) > 0 {
		minLen = len(input[0].key)
	}
	for i, r := range input {
		rows[i] = row{key: r.key[p:], value: r.value, summary: r.summary}
		summaries[i] = r.summary
		keys[i] = r.key
		if len(r.key) < minLen {
			minLen = len(r.key)
		}
		if len(r.key) > maxLen {
			maxLen = len(r.key)
		}
		if r.value == nil {
			nullity++
		}
	}
	summary := c.Empty
	if len(input) > 0 {
		summary = checked(c.Combine(summaries))
	}
	own := rows
	var members []*member
	var edged any
	if len(rows) > 255 || (c.TrieInlineCost != nil && (rowCost(rows, c) > 1280 || len(refs(rows, nil, c)) > b.MaxDegree)) {
		own = []row{}
		for _, r := range rows {
			if len(r.key) == 0 {
				own = append(own, r)
			}
		}
		members = make([]*member, 16)
		for high := 0; high < 16; high++ {
			bucket := []row{}
			for _, r := range rows {
				if len(r.key) > 0 && int(r.key[0]>>4) == high {
					bucket = append(bucket, r)
				}
			}
			if len(bucket) > 0 {
				if len(bucket) <= 255 {
					members[high] = &member{group: bucket}
				} else {
					members[high] = &member{nodes: split(b, bucket, c, depth)}
				}
			}
		}
		members = trimMembers(members)
		edged = false
	}
	if len(members) > 0 && (inlined(own, members, c) > 1280 || len(refs(own, members, c)) > b.MaxDegree) {
		if len(refs(own, members, c)) > b.MaxDegree || c.TrieInlineCost != nil {
			for high, m := range members {
				if m != nil && m.nodes == nil {
					members[high] = &member{nodes: split(b, m.group, c, depth)}
				}
			}
		}
		for _, m := range members {
			if m != nil && m.nodes != nil {
				for _, ch := range m.nodes {
					if ch != nil && ch.local != nil {
						ch.edge = b.seal(ch.local.Node, ch.local.Edges)
						ch.local = nil
					}
				}
			}
		}
		edged = true
	}
	if c.TrieExternalize != nil && len(refs(own, members, c)) > b.MaxDegree {
		for i := range own {
			own[i].value = c.TrieExternalize(b, own[i].value)
		}
	}
	if c.TrieInlineCost != nil {
		require(inlined(own, members, c) <= 1280, "trie inline budget exceeded")
	}
	edges := refs(own, members, c)
	degree := 0
	var nested any
	if len(members) > 0 {
		slots := make([]any, len(members))
		for i, m := range members {
			if m == nil {
				continue
			}
			if m.nodes == nil {
				degree++
				slots[i] = group(m.group)
			} else {
				low := make([]any, len(m.nodes))
				for j, ch := range m.nodes {
					if ch == nil {
						continue
					}
					degree++
					if ch.local != nil {
						low[j] = ch.local.Node
					} else {
						low[j] = ch.edge
					}
				}
				slots[i] = low
			}
		}
		nested = slots
	}
	var lengths any
	if len(input) > 0 {
		lengths = vector(int64(minLen), int64(maxLen))
	}
	header := map[string]any{"count": big.NewInt(int64(len(input))), "nullity": big.NewInt(int64(nullity)), "degree": int64(degree), "inlined": int64(inlined(own, members, c)), "prefix": prefix, "keys": bounds(keys), "lengths": lengths}
	node := Node{"0": Symbol{Name: "species"}, "1": Domain, "2": TriePath, "3": query(edges, b.MaxDegree, b.MaxHeight), "4": int64(0), "5": header, "6": vector(c.Migration, summary, group(own), nested, edged)}
	return Built{node, edges}
}
func BuildNode(b *Basin, input []Entry, c Consumer) (built Built, err error) {
	defer protect(&err)
	require(c.Entry != nil && c.Combine != nil, "consumer callbacks are required")
	uint32Value(c.Migration)
	rows := make([]row, len(input))
	for i, r := range input {
		rows[i] = row{key: append([]byte{}, r.Key...), value: r.Value, summary: checked(c.Entry(r.Key, r.Value))}
	}
	sort.Slice(rows, func(i, j int) bool { return bytes.Compare(rows[i].key, rows[j].key) < 0 })
	for i := 1; i < len(rows); i++ {
		require(!bytes.Equal(rows[i-1].key, rows[i].key), "duplicate trie key")
	}
	return buildRows(b, rows, c, 0), nil
}
func Build(b *Basin, input []Entry, c Consumer) (edge Edge, err error) {
	defer protect(&err)
	built := checked(BuildNode(b, input, c))
	return b.seal(built.Node, built.Edges), nil
}
func parts(r Ref, migration int64) (header any, group, members Ref, edged any) {
	validateNode(r, TriePath)
	f := r.get("6")
	require(f.len() == 5 && integer(f.item(0).owned(0)) == migration, "unsupported trie migration")
	header = r.get("5").owned(0)
	group = f.item(2)
	require(group.typ == 9 && group.get("keys").len() <= 255 && group.get("keys").len() == group.get("values").len(), "invalid group")
	members = f.item(3)
	edged = f.item(4).owned(0)
	if edged == nil {
		require(members.typ == 0, "invalid nesting")
	} else {
		boolean(edged)
		require(members.typ == 10 && members.len() <= 16, "invalid nibble slots")
	}
	return
}
func find(g Ref, k []byte) *Ref {
	keys, values := g.get("keys"), g.get("values")
	require(keys.len() <= 255 && keys.len() == values.len(), "invalid group")
	low, high := 0, keys.len()
	for low < high {
		mid := (low + high) / 2
		if bytes.Compare(keys.item(mid).bytes(), k) < 0 {
			low = mid + 1
		} else {
			high = mid
		}
	}
	if low < keys.len() && bytes.Equal(keys.item(low).bytes(), k) {
		r := values.item(low)
		return &r
	}
	return nil
}
func lookupInline(b *Basin, r Ref, key []byte, migration int64, cacheOnly bool) (*Ref, bool) {
	k := key
	depth := 0
	for {
		require(depth < 256, "trie nesting limit")
		depth++
		h, g, m, e := parts(r, migration)
		p := []byte{}
		if v := field(h, "prefix"); v != nil {
			p = blob(v)
		}
		if !bytes.HasPrefix(k, p) {
			return nil, true
		}
		k = k[len(p):]
		if found := find(g, k); found != nil {
			return found, true
		}
		if len(k) == 0 || e == nil {
			return nil, true
		}
		high, low := int(k[0]>>4), int(k[0]&15)
		if high >= m.len() || m.item(high).typ == 0 {
			return nil, true
		}
		member := m.item(high)
		if member.typ == 9 {
			return find(member, k), true
		}
		require(member.typ == 10 && member.len() <= 16, "invalid nibble slots")
		if low >= member.len() || member.item(low).typ == 0 {
			return nil, true
		}
		child := member.item(low)
		k = k[1:]
		if boolean(e) {
			edge := array(child.owned(0))
			bounds := field(edge[5], "keys")
			if bounds == nil || bytes.Compare(k, blob(at(bounds, 0))) < 0 || bytes.Compare(k, blob(at(bounds, 1))) > 0 {
				return nil, true
			}
			if cacheOnly {
				cached := b.peek(edge)
				if cached == nil {
					return nil, false
				}
				r = *cached
			} else {
				r = b.load(edge)
			}
		} else {
			r = child
		}
	}
}
func getInline(b *Basin, r Ref, k []byte, migration int64) *Ref {
	v, ready := lookupInline(b, r, k, migration, false)
	require(ready, "unexpected deferred lookup")
	return v
}
func GetView(b *Basin, root Edge, key []byte, migration int64) (view *Ref, err error) {
	defer protect(&err)
	validateTrieRoot(root, migration)
	if !inBounds(root, key) {
		return nil, nil
	}
	return getInline(b, b.load(root), key, migration), nil
}
func Get(b *Basin, root Edge, key []byte, migration int64) (value any, found bool, err error) {
	defer protect(&err)
	validateTrieRoot(root, migration)
	if !inBounds(root, key) {
		return nil, false, nil
	}
	r := getInline(b, b.load(root), key, migration)
	if r == nil {
		return nil, false, nil
	}
	return r.owned(0), true, nil
}
func intersects(base []byte, h any, p []byte) bool {
	bounds := field(h, "keys")
	if bounds == nil {
		return false
	}
	lo := append(append([]byte{}, base...), blob(at(bounds, 0))...)
	hi := append(append([]byte{}, base...), blob(at(bounds, 1))...)
	if bytes.Compare(hi, p) < 0 {
		return false
	}
	end := append([]byte{}, p...)
	for i := len(end) - 1; i >= 0; i-- {
		if end[i] < 255 {
			end[i]++
			end = end[:i+1]
			return bytes.Compare(lo, end) < 0
		}
	}
	return true
}
func visitInline(b *Basin, r Ref, base, prefix []byte, migration int64, accept func(any, any) bool, emit func([]byte, Ref) (bool, error)) bool {
	return visitDepth(b, r, base, prefix, migration, accept, emit, 0)
}
func visitDepth(b *Basin, r Ref, base, prefix []byte, migration int64, accept func(any, any) bool, emit func([]byte, Ref) (bool, error), depth int) bool {
	require(depth < 256, "trie nesting limit")
	h, g, m, e := parts(r, migration)
	if !intersects(base, h, prefix) || !accept(h, r.get("6").item(1).owned(0)) {
		return true
	}
	here := append([]byte{}, base...)
	if p := field(h, "prefix"); p != nil {
		here = append(here, blob(p)...)
	}
	emitGroup := func(g Ref) bool {
		keys, values := g.get("keys"), g.get("values")
		require(keys.len() <= 255 && keys.len() == values.len(), "invalid group")
		for i := 0; i < keys.len(); i++ {
			k := append(append([]byte{}, here...), keys.item(i).bytes()...)
			if bytes.HasPrefix(k, prefix) && !checked(emit(k, values.item(i))) {
				return false
			}
		}
		return true
	}
	if !emitGroup(g) {
		return false
	}
	if e != nil {
		for high := 0; high < m.len(); high++ {
			member := m.item(high)
			if member.typ == 0 {
				continue
			}
			if member.typ == 9 {
				if !emitGroup(member) {
					return false
				}
				continue
			}
			require(member.typ == 10 && member.len() <= 16, "invalid nibble slots")
			for low := 0; low < member.len(); low++ {
				child := member.item(low)
				if child.typ == 0 {
					continue
				}
				next := append(append([]byte{}, here...), byte(high<<4|low))
				if boolean(e) {
					edge := array(child.owned(0))
					if intersects(next, edge[5], prefix) && accept(edge[5], field(edge[6], "1")) {
						if !visitDepth(b, b.load(edge), next, prefix, migration, accept, emit, depth+1) {
							return false
						}
					}
				} else if !visitDepth(b, child, next, prefix, migration, accept, emit, depth+1) {
					return false
				}
			}
		}
	}
	return true
}
func Visit(b *Basin, root Edge, prefix []byte, migration int64, accept func(any, any) bool, emit func([]byte, Ref) (bool, error)) (err error) {
	defer protect(&err)
	validateTrieRoot(root, migration)
	if intersects(nil, root[5], prefix) && accept(root[5], field(root[6], "1")) {
		visitInline(b, b.load(root), nil, prefix, migration, accept, emit)
	}
	return nil
}
func Entries(b *Basin, root Edge, prefix []byte, migration int64) (out []Entry, err error) {
	out = []Entry{}
	err = Visit(b, root, prefix, migration, func(any, any) bool { return true }, func(k []byte, r Ref) (bool, error) { out = append(out, Entry{k, r.owned(0)}); return true, nil })
	return
}

type Change struct {
	Key    []byte
	Value  any
	Delete bool
}

func Update(b *Basin, root Edge, changes []Change, c Consumer) (edge Edge, err error) {
	defer protect(&err)
	rows := checked(Entries(b, root, nil, c.Migration))
	values := map[string]Entry{}
	for _, r := range rows {
		values[hex.EncodeToString(r.Key)] = r
	}
	for _, change := range changes {
		k := hex.EncodeToString(change.Key)
		if change.Delete {
			delete(values, k)
		} else {
			values[k] = Entry{change.Key, change.Value}
		}
	}
	input := make([]Entry, 0, len(values))
	for _, r := range values {
		input = append(input, r)
	}
	return Build(b, input, c)
}

func inBounds(root Edge, key []byte) bool {
	v := field(root[5], "keys")
	return v != nil && bytes.Compare(key, blob(at(v, 0))) >= 0 && bytes.Compare(key, blob(at(v, 1))) <= 0
}

func validateTrieRoot(root Edge, migration int64) {
	validateEdge(root)
	require(text(root[1]) == Domain && text(root[2]) == TriePath && integer(field(root[6], "0")) == migration, "unsupported trie species/migration")
}
