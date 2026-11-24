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
func deviceConsumer() Consumer {
	c := PlainConsumer()
	c.Edges = func(v any) ([]Edge, error) {
		a := array(v)
		require(len(a) == 1, "invalid device value")
		e := array(a[0])
		validateEdge(e)
		return []Edge{e}, nil
	}
	return c
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
func collectLeaves(b *Basin, node Node, base []byte, out *[]any) {
	h := node["5"]
	here := append([]byte{}, base...)
	if p := field(h, "prefix"); p != nil {
		here = append(here, blob(p)...)
	}
	members := at(node["6"], 3)
	if members == nil {
		return
	}
	for high, m := range array(members) {
		children, ok := m.([]any)
		if !ok {
			continue
		}
		for low, ch := range children {
			if ch == nil {
				continue
			}
			next := append(append([]byte{}, here...), byte(high<<4|low))
			if edge, ok := ch.([]any); ok {
				header := edge[5]
				if uint32Value(field(edge[3], "degree")) == 0 && field(header, "keys") != nil {
					keys := array(field(header, "keys"))
					lo := unlex(string(append(append([]byte{}, next...), blob(keys[0])...)))
					hi := unlex(string(append(append([]byte{}, next...), blob(keys[1])...)))
					hi.Add(hi, big.NewInt(1))
					span := new(big.Int).Sub(hi, lo)
					if span.IsUint64() && span.Uint64() <= 0xffffffff {
						*out = append(*out, vector(lo, int64(span.Uint64()), weak(edge)))
					}
				} else {
					collectLeaves(b, mapping(b.load(edge).owned(0)), next, out)
				}
			} else {
				collectLeaves(b, mapping(ch), next, out)
			}
		}
	}
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

func BuildBlock(b *Basin, input []PageInput) (block BlockRoot, err error) {
	defer protect(&err)
	rows := make([]Entry, len(input))
	for i, p := range input {
		rows[i] = Entry{[]byte(lex(p.Index)), vector(p.Bytes)}
	}
	t := checked(BuildNode(b, rows, sectorConsumer()))
	leaves := []any{}
	collectLeaves(b, t.Node, nil, &leaves)
	sort.Slice(leaves, func(i, j int) bool { return bigint(at(leaves[i], 0)).Cmp(bigint(at(leaves[j], 0))) < 0 })
	shortcutRows := make([]VectorEntry, len(leaves))
	for i, v := range leaves {
		shortcutRows[i] = VectorEntry{big.NewInt(int64(i)), v}
	}
	shortcuts := buildVectorNodeEntries(b, big.NewInt(int64(len(shortcutRows))), shortcutRows, PlainConsumer(), 7)
	sum := blob(at(t.Node["6"], 1).(map[string]any)["brombergSL2"])
	packed := packChildren(b, []packedBuilt{{node: t.Node, edges: t.Edges}, shortcuts}, 0, nil)
	pages, trailing := packed.slots[0], packed.slots[1]
	leading, lagging := vectorSpine(b, trailing, false), vectorSpine(b, trailing, true)
	node := Node{"0": Symbol{Name: "species"}, "1": Domain, "2": BlockPath, "3": query(packed.edges, b.MaxDegree, b.MaxHeight), "4": int64(0), "5": nil, "6": vector(int64(0), nil, pages, trailing, leading, lagging)}
	return BlockRoot{b.seal(node, packed.edges), sum}, nil
}
func vectorSpine(b *Basin, root any, last bool) []any {
	var n any = root
	if e, ok := n.([]any); ok {
		n = b.load(e).owned(0)
	}
	spine := make([]any, int(integer(field(field(n, "3"), "height"))))
	for depth := 0; depth < 256; depth++ {
		if integer(field(field(n, "5"), "shift")) == 0 || bigint(field(field(n, "5"), "count")).Sign() == 0 {
			return spine
		}
		slots := array(at(field(n, "6"), 3))
		at := 0
		if last {
			at = len(slots) - 1
		}
		child := slots[at]
		if e, ok := child.([]any); ok {
			spine[int(integer(field(e[3], "height")))] = weak(e)
			n = b.load(e).owned(0)
		} else {
			n = child
		}
	}
	require(false, "vector nesting limit")
	return nil
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
	deviceRows := make([]Entry, 0, len(files))
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
		deviceRows = append(deviceRows, Entry{[]byte(name), vector(f.edge)})
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
		dir[last] = vector(false, f.sum, weak(f.edge))
	}
	device := checked(BuildNode(b, deviceRows, deviceConsumer()))
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
	node := Node{"0": Symbol{Name: "species"}, "1": Domain, "2": VolumePath, "3": device.Node["3"], "4": int64(0), "5": nil, "6": vector(int64(0), nil, device.Node, finish(tree))}
	return b.seal(node, device.Edges), nil
}
func volumeData(b *Basin, root Edge) Ref {
	r := b.load(root)
	validateNode(r, VolumePath)
	f := r.get("6")
	require(f.len() == 4 && integer(f.item(0).owned(0)) == 0, "unsupported volume migration")
	return f
}
func List(b *Basin, root Edge, name string) (names []string, err error) {
	defer protect(&err)
	node := volumeData(b, root).item(3).owned(0)
	if name != "/" {
		for _, p := range path(name) {
			require(boolean(at(node, 0)), "not a directory")
			node = field(at(node, 2), p)
		}
	}
	require(boolean(at(node, 0)), "not a directory")
	contents := mapping(at(node, 2))
	names = make([]string, 0, len(contents))
	for name := range contents {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
func tryWeak(b *Basin, file []any) (edge Edge, err error) {
	defer protect(&err)
	resolver, ok := b.Storage.(Resolver)
	if !ok {
		return nil, nil
	}
	edge = checked(resolver.Resolve(file[2]))
	if edge == nil {
		return nil, nil
	}
	require(capability(edge) == weakKey(file[2]), "shortcut capability mismatch")
	r := b.load(edge)
	validateNode(r, BlockPath)
	sum := pageRoot(b, r.get("6")).get("6").item(1).get("brombergSL2").bytes()
	require(bytes.Equal(sum, blob(file[1])), "shortcut summary mismatch")
	return edge, nil
}
func openBlock(b *Basin, root Edge, name string, shortcuts bool) (footer Ref, expected []byte, err error) {
	defer protect(&err)
	f := volumeData(b, root)
	node := f.item(3).owned(0)
	for _, p := range path(name) {
		require(boolean(at(node, 0)), "not a directory")
		node = field(at(node, 2), p)
	}
	file := array(node)
	require(!boolean(file[0]), "not a file")
	var edge Edge
	if shortcuts {
		candidate, e := tryWeak(b, file)
		if e == nil {
			edge = candidate
		}
	}
	if edge == nil {
		r := getInline(b, f.item(2), []byte(name), 0)
		require(r != nil, "missing retained block")
		edge = array(at(r.owned(0), 0))
	}
	block := b.load(edge)
	validateNode(block, BlockPath)
	footer = block.get("6")
	require(footer.len() == 6 && integer(footer.item(0).owned(0)) == 0, "unsupported block migration")
	require(bytes.Equal(pageRoot(b, footer).get("6").item(1).get("brombergSL2").bytes(), blob(file[1])), "block summary mismatch")
	return footer, blob(file[1]), nil
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

func shortcutPage(b *Basin, leaves Ref, page *big.Int, full []byte) (value any, err error) {
	defer protect(&err)
	resolver, ok := b.Storage.(Resolver)
	if !ok {
		return nil, nil
	}
	var root Ref = leaves
	if root.typ != 9 {
		root = b.load(array(root.owned(0)))
	}
	h, _, _ := vectorParts(root, 0)
	require(integer(field(h, "bits")) == 7, "invalid shortcut vector")
	low, high := new(big.Int), new(big.Int).Set(bigint(field(h, "length")))
	for low.Cmp(high) < 0 {
		mid := new(big.Int).Rsh(new(big.Int).Add(low, high), 1)
		record := getVectorInline(b, root, mid, 0)
		require(record != nil, "shortcut vector hole")
		if bigint(record.item(0).owned(0)).Cmp(page) <= 0 {
			low.Add(mid, big.NewInt(1))
		} else {
			high.Set(mid)
		}
	}
	if low.Sign() == 0 {
		return nil, nil
	}
	record := getVectorInline(b, root, new(big.Int).Sub(low, big.NewInt(1)), 0)
	require(record != nil, "shortcut vector hole")
	start := bigint(record.item(0).owned(0))
	span := uint32Value(record.item(1).owned(0))
	end := new(big.Int).Add(start, new(big.Int).SetUint64(uint64(span)))
	if page.Cmp(end) >= 0 {
		return nil, nil
	}
	link := record.item(2).owned(0)
	edge := checked(resolver.Resolve(link))
	if edge == nil {
		return nil, nil
	}
	require(capability(edge) == weakKey(link), "shortcut capability mismatch")
	r := b.load(edge)
	validateNode(r, TriePath)
	keys := r.get("5").get("keys").owned(0)
	if keys == nil {
		return nil, nil
	}
	minimum := []byte(lex(start))
	suffix := blob(at(keys, 0))
	require(len(minimum) >= len(suffix), "invalid shortcut prefix")
	base := minimum[:len(minimum)-len(suffix)]
	last := new(big.Int).Sub(end, big.NewInt(1))
	require(bytes.Equal(append(append([]byte{}, base...), suffix...), minimum) && bytes.Equal(append(append([]byte{}, base...), blob(at(keys, 1))...), []byte(lex(last))), "shortcut span mismatch")
	if !bytes.HasPrefix(full, base) {
		return nil, nil
	}
	found := getInline(b, r, full[len(base):], 0)
	if found == nil {
		return nil, nil
	}
	return found.owned(0), nil
}

func ReadPage(b *Basin, root Edge, name string, index *big.Int, shortcuts bool) (data []byte, found bool, err error) {
	defer protect(&err)
	footer, _, e := openBlock(b, root, name, shortcuts)
	if e != nil {
		return nil, false, e
	}
	full := []byte(lex(index))
	var value any
	if shortcuts {
		v, e := shortcutPage(b, footer.item(3), index, full)
		if e == nil {
			value = v
		}
	}
	if value == nil {
		r := getInline(b, pageRoot(b, footer), full, 0)
		if r == nil {
			return nil, false, nil
		}
		value = r.owned(0)
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
	pages := pageRoot(b, footer)
	keys := pages.get("5").get("keys").owned(0)
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
		var value any
		if shortcuts {
			fast, e := shortcutPage(b, footer.item(3), page, full)
			if e == nil {
				value = fast
			}
		}
		if value == nil {
			r := getInline(b, pages, full, 0)
			require(r != nil, "missing page")
			value = r.owned(0)
		}
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

func UpdateVolume(b *Basin, root Edge, changes []FileChange) (edge Edge, err error) {
	defer protect(&err)
	files := map[string][]byte{}
	directories := []string{}
	var walk func(string)
	walk = func(dir string) {
		for _, name := range checked(List(b, root, dir)) {
			p := dir + "/" + name
			if dir == "/" {
				p = "/" + name
			}
			if _, e := List(b, root, p); e == nil {
				directories = append(directories, p)
				walk(p)
			} else {
				files[p] = checked(ReadFile(b, root, p, true))
			}
		}
	}
	walk("/")
	for _, c := range changes {
		path(c.Path)
		if c.Delete {
			delete(files, c.Path)
		} else {
			files[c.Path] = c.Bytes
		}
	}
	input := make([]FileInput, 0, len(files))
	for name, b := range files {
		input = append(input, FileInput{name, b})
	}
	return BuildVolume(b, input, directories...)
}
