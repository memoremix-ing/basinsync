package structures

import (
	"bytes"
	"encoding/binary"
	"math/big"
	"sort"
	"strings"
	"unicode/utf8"
)

const VolumePath = ".sync-volume/"
const BlockPath = ".sync-block/"
const PageSize = 4096

var slPrime = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))

type slMatrix = [4]*big.Int

func slIdentity() slMatrix { return slMatrix{big.NewInt(1), new(big.Int), new(big.Int), big.NewInt(1)} }
func slBytes(m slMatrix) []byte {
	out := make([]byte, 64)
	for i, n := range m {
		n.FillBytes(out[i*16 : (i+1)*16])
	}
	return out
}
func slRead(b []byte) slMatrix {
	require(len(b) == 64, "invalid SL2 length")
	var m slMatrix
	for i := range m {
		m[i] = new(big.Int).SetBytes(b[i*16 : (i+1)*16])
		require(m[i].Cmp(slPrime) < 0, "noncanonical SL2 field")
	}
	d := new(big.Int).Sub(new(big.Int).Mul(m[0], m[3]), new(big.Int).Mul(m[1], m[2]))
	require(d.Mod(d, slPrime).Cmp(big.NewInt(1)) == 0, "invalid SL2 determinant")
	return m
}
func slMultiply(a, b slMatrix) slMatrix {
	dot := func(x, y, z, w *big.Int) *big.Int {
		n := new(big.Int).Add(new(big.Int).Mul(x, y), new(big.Int).Mul(z, w))
		return n.Mod(n, slPrime)
	}
	return slMatrix{dot(a[0], b[0], a[1], b[2]), dot(a[0], b[1], a[1], b[3]), dot(a[2], b[0], a[3], b[2]), dot(a[2], b[1], a[3], b[3])}
}
func Bromberg(input []byte) []byte {
	m := slIdentity()
	for _, b := range input {
		for bit := 7; bit >= 0; bit-- {
			if (b>>bit)&1 == 1 {
				m[1].Add(m[1], new(big.Int).Lsh(new(big.Int).Set(m[0]), 1)).Mod(m[1], slPrime)
				m[3].Add(m[3], new(big.Int).Lsh(new(big.Int).Set(m[2]), 1)).Mod(m[3], slPrime)
			} else {
				m[0].Add(m[0], new(big.Int).Lsh(new(big.Int).Set(m[1]), 1)).Mod(m[0], slPrime)
				m[2].Add(m[2], new(big.Int).Lsh(new(big.Int).Set(m[3]), 1)).Mod(m[2], slPrime)
			}
		}
	}
	return slBytes(m)
}
func combineSL(digests [][]byte) []byte {
	m := slIdentity()
	for _, b := range digests {
		m = slMultiply(m, slRead(b))
	}
	return slBytes(m)
}
func sectorConsumer() Consumer {
	return Consumer{Empty: map[string]any{"brombergSL2": slBytes(slIdentity())}, Entry: func(_ []byte, v any) (any, error) {
		a := array(v)
		require(len(a) == 1, "invalid page")
		return map[string]any{"brombergSL2": Bromberg(blob(a[0]))}, nil
	}, Combine: func(v []any) (any, error) {
		parts := make([][]byte, len(v))
		for i, s := range v {
			parts[i] = blob(field(s, "brombergSL2"))
		}
		return map[string]any{"brombergSL2": combineSL(parts)}, nil
	}}
}
func lex(n *big.Int) string {
	require(n != nil && n.Sign() >= 0, "negative/missing page")
	digits := n.Text(16)
	size := big.NewInt(int64(len(digits) - 1)).Text(16)
	w := 1
	for w < len(size) {
		w *= 2
	}
	require(w <= 16, "page encoding overflow")
	magnitude := ""
	if w > 1 {
		at := 0
		for x := 2; x < w; x *= 2 {
			at++
		}
		magnitude = string("wxyz"[at])
	}
	size = strings.Repeat("0", w-len(size)) + size
	out := make([]byte, w)
	for i, c := range []byte(size) {
		v := c - byte('0')
		if c >= 'a' {
			v = c - 'a' + 10
		}
		out[i] = 'g' + v
	}
	return "0z" + magnitude + string(out) + digits
}
func unlex(s string) *big.Int {
	require(strings.HasPrefix(s, "0z") && len(s) >= 4, "invalid page key")
	at, w := 2, 1
	if m := strings.IndexByte("wxyz", s[2]); m >= 0 {
		w = 1 << (1 + m)
		at++
	}
	require(at+w < len(s), "truncated page size")
	size := new(big.Int)
	for _, b := range []byte(s[at : at+w]) {
		require(b >= 'g' && b <= 'v', "invalid page size")
		size.Mul(size, big.NewInt(16)).Add(size, big.NewInt(int64(b-'g')))
	}
	payload := s[at+w:]
	require(size.IsInt64() && size.Int64()+1 == int64(len(payload)), "invalid page length")
	n, ok := new(big.Int).SetString(payload, 16)
	require(ok && n.Sign() >= 0 && lex(n) == s, "noncanonical page key")
	return n
}
func path(name string) []string {
	require(utf8.ValidString(name) && strings.HasPrefix(name, "/") && !strings.ContainsRune(name, 0), "invalid pathname")
	parts := strings.Split(name[1:], "/")
	for _, p := range parts {
		require(p != "" && p != "." && p != "..", "invalid pathname component")
	}
	return parts
}
func lengthFrame(b []byte) []byte {
	require(uint64(len(b)) <= 0xffffffff, "oversized field")
	out := make([]byte, 4, len(b)+4)
	binary.LittleEndian.PutUint32(out, uint32(len(b)))
	return append(out, b...)
}
func directory(contents map[string]any) any {
	names := make([]string, 0, len(contents))
	for name := range contents {
		names = append(names, name)
	}
	sort.Strings(names)
	var data []byte
	for _, name := range names {
		item := array(contents[name])
		data = append(data, lengthFrame([]byte(name))...)
		kind := byte(0)
		if boolean(item[0]) {
			kind = 1
		}
		data = append(data, kind)
		data = append(data, lengthFrame(blob(item[1]))...)
	}
	return vector(true, digest(data), contents)
}
func directoryRefs(source any) []Edge {
	if edge, ok := source.([]any); ok {
		return []Edge{edge}
	}
	var scan func(Node) []Edge
	scan = func(n Node) []Edge {
		if integer(field(n["3"], "degree")) == 0 {
			return nil
		}
		group := func(g any) []Edge {
			refs := []Edge{}
			for _, v := range array(field(g, "values")) {
				if boolean(at(v, 0)) {
					refs = append(refs, directoryRefs(at(v, 4))...)
				} else {
					refs = append(refs, array(at(v, 2)))
				}
			}
			return refs
		}
		refs := group(at(n["6"], 2))
		if m := at(n["6"], 3); m != nil {
			for _, high := range array(m) {
				if high == nil {
					continue
				}
				if low, ok := high.([]any); ok {
					for _, child := range low {
						if child == nil {
							continue
						}
						if edge, ok := child.([]any); ok {
							refs = append(refs, edge)
						} else {
							refs = append(refs, scan(mapping(child))...)
						}
					}
				} else {
					refs = append(refs, group(high)...)
				}
			}
		}
		return distinct(refs)
	}
	return scan(mapping(source))
}
func directoryConsumer() Consumer {
	c := PlainConsumer()
	c.TrieInlineCost = func(v any) int {
		if boolean(at(v, 0)) {
			d := array(v)
			if _, edged := d[4].([]any); !edged {
				return 1 + int(integer(d[2]))
			}
		}
		return 1
	}
	c.TrieExternalize = func(b *Basin, v any) any {
		if boolean(at(v, 0)) {
			d := array(v)
			if _, edged := d[4].([]any); !edged {
				source := d[4]
				edge := b.seal(mapping(source), directoryRefs(source))
				return vector(true, d[1], d[2], d[3], edge)
			}
		}
		return v
	}

	c.Edges = func(v any) ([]Edge, error) {
		if boolean(at(v, 0)) {
			return directoryRefs(at(v, 4)), nil
		}
		return []Edge{array(at(v, 2))}, nil
	}
	return c
}

type directoryBuilt struct {
	descriptor []any
	edges      []Edge
}

func directoryStats(node Node) (int, int) {
	depth := 1
	var walk func(Node)
	group := func(g any) {
		for _, v := range array(field(g, "values")) {
			if boolean(at(v, 0)) {
				d := array(v)
				if _, edged := d[4].([]any); !edged {
					h := 1 + int(integer(d[3]))
					if h > depth {
						depth = h
					}
				}
			}
		}
	}
	walk = func(n Node) {
		group(at(n["6"], 2))
		if members := at(n["6"], 3); members != nil {
			for _, m := range array(members) {
				if m == nil {
					continue
				}
				if low, ok := m.([]any); ok {
					for _, ch := range low {
						if ch != nil {
							if _, edged := ch.([]any); !edged {
								walk(mapping(ch))
							}
						}
					}
				} else {
					group(m)
				}
			}
		}
	}
	walk(node)
	return int(integer(field(node["5"], "inlined"))), depth
}
func buildDirectory(b *Basin, tree any) directoryBuilt {
	entries := mapping(at(tree, 2))
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	children := map[string]directoryBuilt{}
	for _, name := range names {
		v := entries[name]
		if boolean(at(v, 0)) {
			children[name] = buildDirectory(b, v)
		}
	}
	rows := []Entry{}
	for _, name := range names {
		v := entries[name]
		stored := v
		if ch, ok := children[name]; ok {
			d := ch.descriptor
			source := d[4]
			if integer(d[2]) >= 1280 || integer(d[3]) >= 32 {
				source = b.seal(mapping(source), ch.edges)
			}
			stored = vector(true, d[1], d[2], d[3], source)
		}
		rows = append(rows, Entry{[]byte(name), stored})
	}
	t := checked(BuildNode(b, rows, directoryConsumer()))
	inline, nesting := directoryStats(t.Node)
	return directoryBuilt{descriptor: vector(true, at(tree, 1), int64(inline), int64(nesting), t.Node), edges: t.Edges}
}
func sourceRoot(b *Basin, source Ref) Ref {
	if source.typ == 9 {
		return source
	}
	return b.load(array(source.owned(0)))
}
func directoryContents(b *Basin, source Ref) Ref { return sourceRoot(b, source.item(4)) }
func directoryEntry(b *Basin, root Edge, name string) (bool, Ref) {
	f := volumeData(b, root)
	source := f.item(2)
	if name == "/" {
		return true, source
	}
	parts := path(name)
	for i, p := range parts {
		contents := directoryContents(b, source)
		v := getInline(b, contents, []byte(p), 0)
		require(v != nil, "missing pathname")
		folder := boolean(v.item(0).owned(0))
		if i == len(parts)-1 {
			return folder, *v
		}
		require(folder, "parent is not a directory")
		source = *v
	}
	require(false, "missing pathname")
	return false, Ref{}
}
func materializeDirectory(b *Basin, source Ref) any {
	sum := source.item(1).owned(0)
	n := directoryContents(b, source)
	type row struct {
		name  string
		value Ref
	}
	rows := []row{}
	visitInline(b, n, nil, nil, 0, func(any, any) bool { return true }, func(k []byte, v Ref) (bool, error) { rows = append(rows, row{string(k), v}); return true, nil })
	entries := map[string]any{}
	for _, r := range rows {
		var v any
		if boolean(r.value.item(0).owned(0)) {
			v = materializeDirectory(b, r.value)
			require(bytes.Equal(blob(at(v, 1)), r.value.item(1).bytes()), "directory digest mismatch")
		} else {
			v = r.value.owned(0)
		}
		entries[r.name] = v
	}
	return vector(true, sum, entries)
}

type FileInput struct {
	Path  string
	Bytes []byte
}

type BlockRoot struct {
	Edge   Edge
	Digest []byte
}
type PageInput struct {
	Index *big.Int
	Bytes []byte
}

func pageSpine(b *Basin, root Node, last bool) []any {
	n := root
	base := []byte{}
	spine := make([]any, int(integer(field(root["3"], "height"))))
	for depth := 0; depth < 256; depth++ {
		h := mapping(n["5"])
		if h["keys"] == nil {
			return spine
		}
		which := 0
		if last {
			which = 1
		}
		target := blob(at(h["keys"], which))
		prefix := []byte{}
		if h["prefix"] != nil {
			prefix = blob(h["prefix"])
		}
		members := at(n["6"], 3)
		if members == nil || len(target) == len(prefix) {
			return spine
		}
		index := int(target[len(prefix)])
		high := array(members)
		if index>>4 >= len(high) {
			return spine
		}
		m, ok := high[index>>4].([]any)
		if !ok || index&15 >= len(m) || m[index&15] == nil {
			return spine
		}
		ch := m[index&15]
		base = append(append(append([]byte{}, base...), prefix...), byte(index))
		if e, ok := ch.([]any); ok {
			spine[int(integer(field(e[3], "height")))] = map[string]any{"prefix": append([]byte{}, base...), "sha384": field(e[6], "sha384"), "link": weak(e)}
			if integer(field(e[3], "degree")) == 0 {
				return spine
			}
			n = mapping(b.load(e).owned(0))
		} else {
			n = mapping(ch)
		}
	}
	require(false, "page trie nesting limit")
	return nil
}
func BuildBlock(b *Basin, input []PageInput) (block BlockRoot, err error) {
	defer protect(&err)
	rows := make([]Entry, len(input))
	for i, p := range input {
		rows[i] = Entry{[]byte(lex(p.Index)), vector(p.Bytes)}
	}
	t := checked(BuildNode(b, rows, sectorConsumer()))
	leading, lagging := pageSpine(b, t.Node, false), pageSpine(b, t.Node, true)
	sum := blob(field(at(t.Node["6"], 1), "brombergSL2"))
	var source any = t.Node
	edges := t.Edges
	if integer(field(t.Node["5"], "inlined")) > 1280 {
		source = b.seal(t.Node, t.Edges)
		edges = []Edge{array(source)}
	}
	n := Node{"0": Symbol{Name: "species"}, "1": Domain, "2": BlockPath, "3": query(edges, b.MaxDegree, b.MaxHeight), "4": int64(0), "5": nil, "6": vector(int64(0), nil, source, leading, lagging)}
	return BlockRoot{b.seal(n, edges), sum}, nil
}
func pageRoot(b *Basin, footer Ref) Ref {
	pages := footer.item(2)
	if pages.typ == 9 {
		return pages
	}
	return b.load(array(pages.owned(0)))
}
func BuildVolume(b *Basin, input []FileInput, directories ...string) (root Edge, err error) {
	defer protect(&err)
	blocks := map[string]BlockRoot{}
	for _, f := range input {
		path(f.Path)
		_, exists := blocks[f.Path]
		require(!exists, "duplicate pathname")
		pages := []PageInput{}
		for at := 0; at < len(f.Bytes); at += PageSize {
			end := at + PageSize
			if end > len(f.Bytes) {
				end = len(f.Bytes)
			}
			pages = append(pages, PageInput{big.NewInt(int64(at / PageSize)), append([]byte{}, f.Bytes[at:end]...)})
		}
		blocks[f.Path] = checked(BuildBlock(b, pages))
	}
	return VolumeFromBlocks(b, blocks, directories...)
}
func VolumeFromBlocks(b *Basin, blocks map[string]BlockRoot, directories ...string) (root Edge, err error) {
	defer protect(&err)
	files := map[string]struct {
		edge Edge
		sum  []byte
	}{}
	for name, block := range blocks {
		path(name)
		validateEdge(block.Edge)
		require(text(block.Edge[2]) == BlockPath && len(block.Digest) == 64, "invalid block descriptor")
		files[name] = struct {
			edge Edge
			sum  []byte
		}{block.Edge, block.Digest}
	}
	tree := map[string]any{}
	for _, name := range directories {
		if name == "/" {
			continue
		}
		dir := tree
		for _, part := range path(name) {
			if v, ok := dir[part]; ok {
				dir = mapping(v)
			} else {
				next := map[string]any{}
				dir[part] = next
				dir = next
			}
		}
	}
	for name, f := range files {
		parts := path(name)
		dir := tree
		for _, p := range parts[:len(parts)-1] {
			if v, ok := dir[p]; ok {
				dir = mapping(v)
			} else {
				next := map[string]any{}
				dir[p] = next
				dir = next
			}
		}
		last := parts[len(parts)-1]
		_, exists := dir[last]
		require(!exists, "file/directory collision")
		dir[last] = vector(false, f.sum, f.edge)
	}
	var finish func(map[string]any) any
	finish = func(t map[string]any) any {
		entries := map[string]any{}
		for name, v := range t {
			if sub, ok := v.(map[string]any); ok {
				entries[name] = finish(sub)
			} else {
				entries[name] = v
			}
		}
		return directory(entries)
	}
	dir := buildDirectory(b, finish(tree))
	descriptor := dir.descriptor
	edges := dir.edges
	if integer(descriptor[2]) > 1280 || integer(descriptor[3]) > 32 {
		e := b.seal(mapping(descriptor[4]), dir.edges)
		descriptor[4] = e
		edges = []Edge{e}
	}
	node := Node{"0": Symbol{Name: "species"}, "1": Domain, "2": VolumePath, "3": query(edges, b.MaxDegree, b.MaxHeight), "4": int64(0), "5": nil, "6": vector(int64(0), nil, descriptor)}
	return b.seal(node, edges), nil
}
func volumeData(b *Basin, root Edge) Ref {
	r := b.load(root)
	validateNode(r, VolumePath)
	f := r.get("6")
	require(f.len() == 3 && integer(f.item(0).owned(0)) == 0, "unsupported volume migration")
	return f
}
func List(b *Basin, root Edge, name string) (names []string, err error) {
	defer protect(&err)
	folder, source := directoryEntry(b, root, name)
	require(folder, "not a directory")
	names = []string{}
	visitInline(b, directoryContents(b, source), nil, nil, 0, func(any, any) bool { return true }, func(k []byte, _ Ref) (bool, error) { names = append(names, string(k)); return true, nil })
	return names, nil
}
func readySource(b *Basin, source Ref) *Ref {
	if source.typ == 9 {
		return &source
	}
	return b.peek(array(source.owned(0)))
}
func sectorSummary(footer Ref) any {
	pages := footer.item(2)
	if pages.typ == 9 {
		return pages.get("6").item(1).owned(0)
	}
	return pages.item(6).get("1").owned(0)
}
func openBlock(b *Basin, root Edge, name string, shortcuts bool) (footer Ref, expected []byte, err error) {
	defer protect(&err)
	folder, file := directoryEntry(b, root, name)
	require(!folder, "not a file")
	block := b.load(array(file.item(2).owned(0)))
	validateNode(block, BlockPath)
	footer = block.get("6")
	require(footer.len() == 5, "unsupported block migration")
	sum := blob(field(sectorSummary(footer), "brombergSL2"))
	require(bytes.Equal(sum, file.item(1).bytes()), "block checksum mismatch")
	return footer, sum, nil
}
func ReadFile(b *Basin, root Edge, name string, shortcuts bool) (data []byte, err error) {
	defer protect(&err)
	footer, expected, e := openBlock(b, root, name, shortcuts)
	if e != nil {
		return nil, e
	}

	type page struct {
		at   int
		data []byte
	}
	pages := []page{}
	end := 0
	visitInline(b, pageRoot(b, footer), nil, nil, 0, func(any, any) bool { return true }, func(k []byte, r Ref) (bool, error) {
		p := unlex(string(k))
		offset := new(big.Int).Mul(p, big.NewInt(PageSize))
		require(offset.IsInt64() && offset.Sign() >= 0 && offset.Int64() <= int64(b.MaxBytes), "file read byte limit")
		v := array(r.owned(0))
		require(len(v) == 1, "invalid page")
		blob := blob(v[0])
		require(len(blob) > 0 && len(blob) <= PageSize && offset.Int64()+int64(len(blob)) <= int64(b.MaxBytes), "invalid page")
		at := int(offset.Int64())
		pages = append(pages, page{at, blob})
		if at+len(blob) > end {
			end = at + len(blob)
		}
		return true, nil
	})
	data = make([]byte, end)
	for _, p := range pages {
		copy(data[p.at:], p.data)
	}
	require(bytes.Equal(Bromberg(data), expected), "file checksum mismatch")
	return data, nil
}

func shortcutPage(b *Basin, footer Ref, full []byte) (value any, err error) {
	defer protect(&err)
	resolver, ok := b.Storage.(Resolver)
	if !ok {
		return nil, nil
	}
	hints := append(append([]any{}, array(footer.item(3).owned(0))...), array(footer.item(4).owned(0))...)
	filtered := []any{}
	for _, h := range hints {
		if h != nil {
			filtered = append(filtered, h)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return integer(field(field(filtered[i], "link"), "height")) < integer(field(field(filtered[j], "link"), "height"))
	})
	for _, h := range filtered {
		v, e := func() (out any, err error) {
			defer protect(&err)
			prefix := blob(field(h, "prefix"))
			if !bytes.HasPrefix(full, prefix) {
				return nil, nil
			}
			pointer := field(h, "link")
			edge := checked(resolver.Resolve(pointer))
			if edge == nil {
				return nil, nil
			}
			require(capability(edge) == weakKey(pointer) && bytes.Equal(blob(field(edge[6], "sha384")), blob(field(h, "sha384"))), "page shortcut identity mismatch")
			keys := field(edge[5], "keys")
			k := full[len(prefix):]
			if keys == nil || bytes.Compare(k, blob(at(keys, 0))) < 0 || bytes.Compare(k, blob(at(keys, 1))) > 0 {
				return nil, nil
			}
			r := getInline(b, b.load(edge), k, 0)
			if r == nil {
				return nil, nil
			}
			return r.owned(0), nil
		}()
		if e == nil && v != nil {
			return v, nil
		}
	}
	return nil, nil
}
func pageValue(b *Basin, f Ref, full []byte, shortcuts bool) any {
	if root := readySource(b, f.item(2)); root != nil {
		v, ready := lookupInline(b, *root, full, 0, true)
		if ready {
			if v == nil {
				return nil
			}
			return v.owned(0)
		}
	}
	if shortcuts {
		v, e := shortcutPage(b, f, full)
		if e == nil && v != nil {
			return v
		}
	}
	v := getInline(b, pageRoot(b, f), full, 0)
	if v == nil {
		return nil
	}
	return v.owned(0)
}

func ReadPage(b *Basin, root Edge, name string, index *big.Int, shortcuts bool) (data []byte, found bool, err error) {
	defer protect(&err)
	footer, _, e := openBlock(b, root, name, shortcuts)
	if e != nil {
		return nil, false, e
	}
	full := []byte(lex(index))
	value := pageValue(b, footer, full, shortcuts)
	if value == nil {
		return nil, false, nil
	}
	require(len(array(value)) == 1, "invalid page")
	return append([]byte{}, blob(at(value, 0))...), true, nil
}

// ReadRange verifies fetched basin-object hashes without downloading unrelated pages.
func ReadRange(b *Basin, root Edge, name string, start uint64, length int, shortcuts bool) (data []byte, err error) {
	defer protect(&err)
	require(length >= 0 && length <= b.MaxBytes && uint64(length) <= ^uint64(0)-start, "invalid file range")
	footer, _, e := openBlock(b, root, name, shortcuts)
	if e != nil {
		return nil, e
	}
	if length == 0 {
		return []byte{}, nil
	}
	source := footer.item(2).owned(0)
	var header any
	if e, ok := source.([]any); ok {
		header = e[5]
	} else {
		header = field(source, "5")
	}
	keys := field(header, "keys")
	if keys == nil {
		return []byte{}, nil
	}
	highest := unlex(string(blob(at(keys, 1))))
	first := new(big.Int).SetUint64(start / PageSize)
	if first.Cmp(highest) > 0 {
		return []byte{}, nil
	}
	last := new(big.Int).SetUint64((start + uint64(length) - 1) / PageSize)
	if last.Cmp(highest) > 0 {
		last.Set(highest)
	}
	window := new(big.Int).Add(last, big.NewInt(1))
	window.Mul(window, big.NewInt(PageSize)).Sub(window, new(big.Int).SetUint64(start))
	if window.Cmp(big.NewInt(int64(length))) > 0 {
		window.SetInt64(int64(length))
	}
	require(window.IsInt64() && window.Sign() >= 0, "invalid range length")
	data = make([]byte, int(window.Int64()))
	actual := len(data)
	for page := new(big.Int).Set(first); page.Cmp(last) <= 0; page.Add(page, big.NewInt(1)) {
		full := []byte(lex(page))
		value := pageValue(b, footer, full, shortcuts)
		require(value != nil, "missing page")
		values := array(value)
		require(len(values) == 1, "invalid page")
		blob := blob(values[0])
		require(len(blob) > 0 && len(blob) <= PageSize, "invalid page")
		offset := new(big.Int).Mul(page, big.NewInt(PageSize))
		offset.Sub(offset, new(big.Int).SetUint64(start))
		require(offset.IsInt64(), "range offset overflow")
		at := offset.Int64()
		from, target := int64(0), at
		if from = -at; from < 0 {
			from = 0
		}
		if target < 0 {
			target = 0
		}
		count := int64(len(blob)) - from
		if n := int64(len(data)) - target; n < count {
			count = n
		}
		if count > 0 {
			copy(data[target:target+count], blob[from:from+count])
		}
		if page.Cmp(highest) == 0 {
			end := at + int64(len(blob))
			if end < 0 {
				end = 0
			}
			if end < int64(actual) {
				actual = int(end)
			}
		}
	}
	return data[:actual], nil
}

type FileChange struct {
	Path   string
	Bytes  []byte
	Delete bool
}

type volumeCatalogue struct {
	files map[string]BlockRoot
	dirs  map[string]bool
}

func catalogue(b *Basin, root Edge) volumeCatalogue {
	f := volumeData(b, root)
	c := volumeCatalogue{map[string]BlockRoot{}, map[string]bool{}}
	var walk func(any, string)
	walk = func(v any, prefix string) {
		for name, entry := range mapping(at(v, 2)) {
			path := prefix + "/" + name
			if boolean(at(entry, 0)) {
				c.dirs[path] = true
				walk(entry, path)
			} else {
				c.files[path] = BlockRoot{array(at(entry, 2)), blob(at(entry, 1))}
			}
		}
	}
	walk(materializeDirectory(b, f.item(2)), "")
	return c
}
func (c volumeCatalogue) exists(n string) bool { _, ok := c.files[n]; return ok || c.dirs[n] }
func (c volumeCatalogue) save(b *Basin) Edge {
	dirs := []string{}
	for n := range c.dirs {
		dirs = append(dirs, n)
	}
	return checked(VolumeFromBlocks(b, c.files, dirs...))
}
func transferVolume(b *Basin, root Edge, from, to string, moving, replace bool) Edge {
	path(from)
	path(to)
	c := catalogue(b, root)
	require(c.exists(from), "missing pathname")
	if from == to {
		require(moving, "cannot copy onto itself")
		return root
	}
	require(!strings.HasPrefix(to, from+"/"), "destination is inside source")
	parent := to[:strings.LastIndex(to, "/")]
	require(parent == "" || c.dirs[parent], "missing parent directory")
	directory := c.dirs[from]
	if c.exists(to) {
		require(replace, "destination exists")
		require(directory == c.dirs[to], "file/directory collision")
		if directory {
			for n := range c.files {
				require(!strings.HasPrefix(n, to+"/"), "destination directory is not empty")
			}
			for n := range c.dirs {
				require(!strings.HasPrefix(n, to+"/"), "destination directory is not empty")
			}
		}
	}
	selected := func(n string) bool { return n == from || directory && strings.HasPrefix(n, from+"/") }
	files := map[string]BlockRoot{}
	dirs := []string{}
	for n, v := range c.files {
		if selected(n) {
			files[to+n[len(from):]] = v
			if moving {
				delete(c.files, n)
			}
		}
	}
	for n := range c.dirs {
		if selected(n) {
			dirs = append(dirs, to+n[len(from):])
			if moving {
				delete(c.dirs, n)
			}
		}
	}
	for n, v := range files {
		c.files[n] = v
	}
	for _, n := range dirs {
		c.dirs[n] = true
	}
	return c.save(b)
}

// Exact destination; replace permits matching kinds and empty destination directories.
func MoveVolume(b *Basin, root Edge, from, to string, replace bool) (edge Edge, err error) {
	defer protect(&err)
	return transferVolume(b, root, from, to, true, replace), nil
}
func CopyVolume(b *Basin, root Edge, from, to string, replace bool) (edge Edge, err error) {
	defer protect(&err)
	return transferVolume(b, root, from, to, false, replace), nil
}
func RemoveVolume(b *Basin, root Edge, name string, recursive bool) (edge Edge, err error) {
	defer protect(&err)
	path(name)
	c := catalogue(b, root)
	require(c.exists(name), "missing pathname")
	for n := range c.files {
		if strings.HasPrefix(n, name+"/") {
			require(recursive, "directory is not empty")
		}
	}
	for n := range c.dirs {
		if strings.HasPrefix(n, name+"/") {
			require(recursive, "directory is not empty")
		}
	}
	for n := range c.files {
		if n == name || strings.HasPrefix(n, name+"/") {
			delete(c.files, n)
		}
	}
	for n := range c.dirs {
		if n == name || strings.HasPrefix(n, name+"/") {
			delete(c.dirs, n)
		}
	}
	return c.save(b), nil
}

func UpdateVolume(b *Basin, root Edge, changes []FileChange) (edge Edge, err error) {
	defer protect(&err)
	c := catalogue(b, root)
	for _, change := range changes {
		path(change.Path)
		if change.Delete {
			delete(c.files, change.Path)
		} else {
			pages := []PageInput{}
			for at := 0; at < len(change.Bytes); at += PageSize {
				end := at + PageSize
				if end > len(change.Bytes) {
					end = len(change.Bytes)
				}
				pages = append(pages, PageInput{big.NewInt(int64(at / PageSize)), change.Bytes[at:end]})
			}
			c.files[change.Path] = checked(BuildBlock(b, pages))
		}
	}
	return c.save(b), nil
}
