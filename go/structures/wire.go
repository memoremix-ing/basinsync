// Package structures implements versioned Basinsync DAG structures.
package structures

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Symbol struct {
	Name   string
	Global bool
}
type schemaError struct{ error }

func require(ok bool, format string, args ...any) {
	if !ok {
		panic(schemaError{fmt.Errorf(format, args...)})
	}
}
func checked[T any](v T, err error) T {
	if err != nil {
		panic(schemaError{err})
	}
	return v
}

// Parsing errors unwind internally; exported entry points convert them to errors.
// Unexpected programmer panics are deliberately not swallowed.
func protect(err *error) {
	if r := recover(); r != nil {
		if e, ok := r.(schemaError); ok {
			*err = e.error
		} else {
			panic(r)
		}
	}
}
func array(v any) []any { a, ok := v.([]any); require(ok, "expected vector"); return a }
func mapping(v any) map[string]any {
	m, ok := v.(map[string]any)
	require(ok, "expected map")
	return m
}
func field(v any, k string) any {
	m := mapping(v)
	x, ok := m[k]
	require(ok, "missing field %s", k)
	return x
}
func at(v any, n int) any {
	a := array(v)
	require(n >= 0 && n < len(a), "missing vector field")
	return a[n]
}
func integer(v any) int64 {
	n, ok := v.(int64)
	if !ok {
		if i, yes := v.(int); yes {
			return int64(i)
		}
	}
	require(ok, "expected integer")
	return n
}
func uint32Value(v any) uint32 {
	n := integer(v)
	require(n >= 0 && n <= math.MaxUint32, "invalid u32")
	return uint32(n)
}
func bigint(v any) *big.Int { n, ok := v.(*big.Int); require(ok, "expected bigint"); return n }
func blob(v any) []byte     { b, ok := v.([]byte); require(ok, "expected blob"); return b }
func text(v any) string     { s, ok := v.(string); require(ok, "expected string"); return s }
func boolean(v any) bool    { b, ok := v.(bool); require(ok, "expected boolean"); return b }
func wellKnown(s string) bool {
	return s == "asyncIterator" || s == "iterator" || s == "match" || s == "species" || s == "unscopables"
}
func vector(values ...any) []any { return values }
func number(n int) any           { return int64(n) }

func ParseJSON0(b []byte) (v any, err error) {
	defer protect(&err)
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var value any
	checked(0, d.Decode(&value))
	return parseJSON(value), nil
}
func parseJSON(v any) any {
	switch x := v.(type) {
	case json.Number:
		if n, e := strconv.ParseInt(string(x), 10, 64); e == nil {
			require(n >= -9007199254740991 && n <= 9007199254740991, "unsafe JSON integer")
			return n
		}
		return checked(strconv.ParseFloat(string(x), 64))
	case string:
		if len(x) > 1 && x[0] == '0' {
			switch x[1] {
			case '0':
				return x[1:]
			case '*':
				return checked(base64.RawURLEncoding.DecodeString(x[2:]))
			case 'x', '~':
				n, ok := new(big.Int).SetString(x[2:], 16)
				require(ok && n.Sign() >= 0, "invalid bigint")
				if x[1] == '~' {
					n.Not(n)
				}
				return n
			case '#':
				require(wellKnown(x[2:]), "unsupported symbol")
				return Symbol{Name: x[2:]}
			case '$':
				return Symbol{Name: x[2:], Global: true}
			default:
				require(false, "unsupported JSON0 prefix")
			}
		}
		return x
	case []any:
		for i, v := range x {
			x[i] = parseJSON(v)
		}
		return x
	case map[string]any:
		for k, v := range x {
			x[k] = parseJSON(v)
		}
		return x
	default:
		return v
	}
}
func JSON0(v any) (b []byte, err error) { defer protect(&err); return json.Marshal(jsonValue(v)) }
func jsonValue(v any) any {
	switch x := v.(type) {
	case []byte:
		return "0*" + base64.RawURLEncoding.EncodeToString(x)
	case *big.Int:
		if x.Sign() < 0 {
			return "0~" + new(big.Int).Not(x).Text(16)
		}
		return "0x" + x.Text(16)
	case Symbol:
		if x.Global {
			return "0$" + x.Name
		}
		require(wellKnown(x.Name), "unsupported symbol")
		return "0#" + x.Name
	case string:
		if len(x) > 1 && x[0] == '0' {
			return "0" + x
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = jsonValue(v)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, v := range x {
			out[k] = jsonValue(v)
		}
		return out
	default:
		return v
	}
}

type encoded struct {
	typ      byte
	width    int
	address  int
	bits     uint64
	indirect bool
}
type writer struct{ b []byte }

func width(n uint64) int {
	for _, w := range []int{1, 2, 4, 8} {
		if w == 8 || n < (uint64(1)<<(8*w)) {
			return w
		}
	}
	return 8
}
func signedWidth(n int64) int {
	for _, w := range []int{1, 2, 4} {
		if n >= -(int64(1)<<(8*w-1)) && n < (int64(1)<<(8*w-1)) {
			return w
		}
	}
	return 8
}
func logWidth(w int) byte {
	switch w {
	case 1:
		return 0
	case 2:
		return 1
	case 4:
		return 2
	case 8:
		return 3
	}
	require(false, "invalid width")
	return 0
}
func (w *writer) align(n int) {
	for len(w.b)%n != 0 {
		w.b = append(w.b, 0)
	}
}
func (w *writer) word(n uint64, size int) {
	for i := 0; i < size; i++ {
		w.b = append(w.b, byte(n>>(8*i)))
	}
}
func (w *writer) slot(v encoded, size int) {
	if v.indirect {
		require(len(w.b) >= v.address, "forward reference")
		w.word(uint64(len(w.b)-v.address), size)
	} else {
		w.word(v.bits, size)
	}
}
func fits(n uint64, size int) bool { return size == 8 || n < (uint64(1)<<(size*8)) }
func (w *writer) vec(values []encoded, typ byte, keys *encoded) encoded {
	prefix := 1
	if typ == 9 {
		prefix = 3
	}
	size := 1
	for _, candidate := range []int{1, 2, 4, 8} {
		start := (len(w.b) + candidate - 1) / candidate * candidate
		ok := fits(uint64(len(values)), candidate)
		if keys != nil {
			ok = ok && fits(uint64(start-keys.address), candidate)
		}
		for i, v := range values {
			if v.indirect {
				ok = ok && fits(uint64(start+(prefix+i)*candidate-v.address), candidate)
			} else {
				ok = ok && v.width <= candidate
			}
		}
		if ok {
			size = candidate
			break
		}
	}
	w.align(size)
	if keys != nil {
		w.slot(*keys, size)
		w.word(uint64(keys.width), size)
	}
	w.word(uint64(len(values)), size)
	address := len(w.b)
	for _, v := range values {
		w.slot(v, size)
	}
	if typ == 10 || typ == 9 {
		for _, v := range values {
			childWidth := v.width
			if !v.indirect {
				childWidth = size
			}
			w.b = append(w.b, v.typ<<2|logWidth(childWidth))
		}
	}
	return encoded{typ: typ, width: size, address: address, indirect: true}
}
func (w *writer) make(v any, depth int) encoded {
	require(depth < 1024, "value nesting limit")
	switch x := v.(type) {
	case nil:
		return encoded{typ: 0, width: 1}
	case bool:
		n := uint64(0)
		if x {
			n = 1
		}
		return encoded{typ: 26, width: 1, bits: n}
	case int:
		return w.make(int64(x), depth)
	case int64:
		return encoded{typ: 1, width: signedWidth(x), bits: uint64(x)}
	case float64:
		require(!math.IsNaN(x) && !math.IsInf(x, 0), "nonfinite float")
		return encoded{typ: 3, width: 8, bits: math.Float64bits(x)}
	case string:
		require(utf8.ValidString(x), "invalid UTF-8")
		n := width(uint64(len(x)))
		w.align(n)
		w.word(uint64(len(x)), n)
		at := len(w.b)
		w.b = append(w.b, []byte(x)...)
		w.b = append(w.b, 0)
		return encoded{typ: 5, width: n, address: at, indirect: true}
	case []byte:
		n := width(uint64(len(x)))
		w.align(n)
		w.word(uint64(len(x)), n)
		at := len(w.b)
		w.b = append(w.b, x...)
		return encoded{typ: 25, width: n, address: at, indirect: true}
	case *big.Int:
		n := new(big.Int).Set(x)
		tag := byte('x')
		if n.Sign() < 0 {
			n.Not(n)
			tag = '~'
		}
		b := n.Bytes()
		if len(b) == 0 {
			b = []byte{0}
		}
		return w.extension(append([]byte{tag}, b...))
	case Symbol:
		tag := byte('#')
		if x.Global {
			tag = '$'
		} else {
			require(wellKnown(x.Name), "unsupported symbol")
		}
		return w.extension(append([]byte{tag}, []byte(x.Name)...))
	case []any:
		values := make([]encoded, len(x))
		for i, v := range x {
			values[i] = w.make(v, depth+1)
		}
		return w.vec(values, 10, nil)
	case map[string]any:
		names := make([]string, 0, len(x))
		for k := range x {
			require(!strings.ContainsRune(k, 0) && utf8.ValidString(k), "invalid map key")
			names = append(names, k)
		}
		sort.Strings(names)
		keys := make([]encoded, len(names))
		for i, k := range names {
			at := len(w.b)
			w.b = append(w.b, []byte(k)...)
			w.b = append(w.b, 0)
			keys[i] = encoded{typ: 4, width: 1, address: at, indirect: true}
		}
		ks := w.vec(keys, 14, nil)
		values := make([]encoded, len(names))
		for i, k := range names {
			values[i] = w.make(x[k], depth+1)
		}
		return w.vec(values, 9, &ks)
	default:
		require(false, "unsupported value %T", v)
	}
	return encoded{}
}
func (w *writer) extension(b []byte) encoded {
	v := make([]encoded, len(b))
	for i, n := range b {
		v[i] = encoded{typ: 2, width: 1, bits: uint64(n)}
	}
	return w.vec(v, 12, nil)
}
func Encode(v any) (b []byte, err error) {
	defer protect(&err)
	w := writer{}
	root := w.make(v, 0)
	size := root.width
	if root.indirect {
		for _, n := range []int{1, 2, 4, 8} {
			at := (len(w.b) + n - 1) / n * n
			if fits(uint64(at-root.address), n) {
				size = n
				break
			}
		}
	}
	w.align(size)
	w.slot(root, size)
	childWidth := root.width
	if !root.indirect {
		childWidth = size
	}
	w.b = append(w.b, root.typ<<2|logWidth(childWidth), byte(size))
	return w.b, nil
}

type Ref struct {
	b            []byte
	slot, parent int
	typ          byte
	width        int
}

func readUint(b []byte, at, size int) uint64 {
	require((size == 1 || size == 2 || size == 4 || size == 8) && at >= 0 && at <= len(b)-size, "invalid scalar bounds")
	var n uint64
	for i := 0; i < size; i++ {
		n |= uint64(b[at+i]) << (8 * i)
	}
	return n
}
func rootRef(b []byte) Ref {
	require(len(b) >= 3, "truncated FlexBuffer")
	p := int(b[len(b)-1])
	require(p == 1 || p == 2 || p == 4 || p == 8, "invalid root width")
	packed := b[len(b)-2]
	return Ref{b: b, slot: len(b) - 2 - p, parent: p, typ: packed >> 2, width: 1 << int(packed&3)}
}
func (r Ref) target() int {
	offset := readUint(r.b, r.slot, r.parent)
	require(offset <= uint64(r.slot), "invalid backwards offset")
	return r.slot - int(offset)
}
func (r Ref) len() int {
	if r.typ >= 16 && r.typ <= 24 {
		return 2 + int(r.typ-16)/3
	}
	if r.typ == 0 {
		return 0
	}
	n := readUint(r.b, r.target()-r.width, r.width)
	require(n <= uint64(len(r.b)), "invalid vector length")
	return int(n)
}
func (r Ref) str() string { return string(r.textBytes()) }
func (r Ref) textBytes() []byte {
	require(r.typ == 4 || r.typ == 5, "expected string")
	at := r.target()
	var b []byte
	if r.typ == 4 {
		require(at < len(r.b), "invalid key")
		end := bytes.IndexByte(r.b[at:], 0)
		require(end >= 0, "unterminated key")
		b = r.b[at : at+end]
	} else {
		n := r.len()
		require(at <= len(r.b)-n-1 && r.b[at+n] == 0, "invalid string bounds")
		b = r.b[at : at+n]
	}
	require(utf8.Valid(b), "invalid UTF-8")
	return b
}
func (r Ref) bytes() []byte {
	require(r.typ == 25, "expected blob")
	at, n := r.target(), r.len()
	require(at <= len(r.b)-n, "invalid blob bounds")
	return r.b[at : at+n]
}
func (r Ref) item(i int) Ref {
	n := r.len()
	require(i >= 0 && i < n, "vector index out of bounds")
	at := r.target()
	require(at <= len(r.b)-n*r.width, "invalid vector bounds")
	typ, childWidth := byte(0), 1
	switch {
	case r.typ == 10 || r.typ == 9:
		require(at+n*r.width+i < len(r.b), "truncated type table")
		packed := r.b[at+n*r.width+i]
		typ = packed >> 2
		childWidth = 1 << int(packed&3)
	case r.typ >= 11 && r.typ <= 15:
		typ = r.typ - 10
	case r.typ == 36:
		typ = 26
	case r.typ >= 16 && r.typ <= 24:
		typ = 1 + (r.typ-16)%3
	default:
		require(false, "expected vector")
	}
	return Ref{b: r.b, slot: at + i*r.width, parent: r.width, typ: typ, width: childWidth}
}
func (r Ref) get(k string) Ref {
	require(r.typ == 9, "expected map")
	at := r.target()
	slot := at - 3*r.width
	off := readUint(r.b, slot, r.width)
	require(off <= uint64(slot), "invalid key offset")
	keys := slot - int(off)
	kw := int(readUint(r.b, at-2*r.width, r.width))
	require(kw == 1 || kw == 2 || kw == 4 || kw == 8, "invalid key width")
	n := r.len()
	require(keys >= 0 && keys <= len(r.b)-n*kw, "invalid key vector")
	low, high := 0, n
	for low < high {
		mid := (low + high) / 2
		key := Ref{b: r.b, slot: keys + mid*kw, parent: kw, typ: 4, width: 1}.textBytes()
		if bytes.Compare(key, []byte(k)) < 0 {
			low = mid + 1
		} else {
			high = mid
		}
	}
	require(low < n && bytes.Equal((Ref{b: r.b, slot: keys + low*kw, parent: kw, typ: 4, width: 1}).textBytes(), []byte(k)), "missing field %s", k)
	return r.item(low)
}
func (r Ref) owned(depth int) any {
	require(depth < 1024, "value nesting limit")
	switch r.typ {
	case 0:
		return nil
	case 26:
		return readUint(r.b, r.slot, r.parent) != 0
	case 1, 2, 6, 7:
		at, w := r.slot, r.parent
		if r.typ >= 6 {
			at, w = r.target(), r.width
		}
		n := readUint(r.b, at, w)
		if r.typ == 1 || r.typ == 6 {
			shift := 64 - w*8
			return int64(n<<shift) >> shift
		}
		require(n <= math.MaxInt64, "unsigned scalar exceeds i64")
		return int64(n)
	case 3, 8:
		at, w := r.slot, r.parent
		if r.typ == 8 {
			at, w = r.target(), r.width
		}
		n := readUint(r.b, at, w)
		if w == 4 {
			return float64(math.Float32frombits(uint32(n)))
		}
		require(w == 8, "invalid float width")
		return math.Float64frombits(n)
	case 4, 5:
		return r.str()
	case 25:
		return append([]byte{}, r.bytes()...)
	case 12:
		n := r.len()
		require(n > 0, "empty extension")
		p := make([]byte, n)
		for i := range p {
			n := integer(r.item(i).owned(depth + 1))
			require(n >= 0 && n <= 255, "invalid extension byte")
			p[i] = byte(n)
		}
		switch p[0] {
		case 'x', '~':
			require(len(p) > 1 && (len(p) == 2 || p[1] != 0), "noncanonical bigint")
			n := new(big.Int).SetBytes(p[1:])
			if p[0] == '~' {
				n.Not(n)
			}
			return n
		case '#':
			require(utf8.Valid(p[1:]) && wellKnown(string(p[1:])), "unsupported symbol")
			return Symbol{Name: string(p[1:])}
		case '$':
			require(utf8.Valid(p[1:]), "invalid symbol UTF-8")
			return Symbol{Name: string(p[1:]), Global: true}
		default:
			require(false, "unsupported extension")
		}
	case 9:
		n := r.len()
		at := r.target()
		slot := at - 3*r.width
		off := readUint(r.b, slot, r.width)
		require(off <= uint64(slot), "invalid key offset")
		keys := slot - int(off)
		kw := int(readUint(r.b, at-2*r.width, r.width))
		out := make(map[string]any, n)
		previous := ""
		for i := 0; i < n; i++ {
			key := (Ref{b: r.b, slot: keys + i*kw, parent: kw, typ: 4, width: 1}).str()
			require(i == 0 || key > previous, "duplicate or unsorted map keys")
			previous = key
			out[key] = r.item(i).owned(depth + 1)
		}
		return out
	default:
		require((r.typ >= 10 && r.typ <= 24) || r.typ == 36, "unsupported FlexBuffers type")
		n := r.len()
		out := make([]any, n)
		for i := range out {
			out[i] = r.item(i).owned(depth + 1)
		}
		return out
	}
	return nil
}
func Decode(b []byte) (v any, err error)      { defer protect(&err); return rootRef(b).owned(0), nil }
func (r Ref) Get(k string) (v Ref, err error) { defer protect(&err); return r.get(k), nil }
func (r Ref) Item(i int) (v Ref, err error)   { defer protect(&err); return r.item(i), nil }
func (r Ref) Value() (v any, err error)       { defer protect(&err); return r.owned(0), nil }
func (r Ref) Blob() (b []byte, err error)     { defer protect(&err); return r.bytes(), nil }

// Compare borrowed metadata without JSON0 round trips or owned container copies.
func (r Ref) matches(expected any, depth int) bool {
	require(depth < 1024, "value nesting limit")
	switch v := expected.(type) {
	case nil:
		return r.typ == 0
	case bool:
		return r.typ == 26 && r.owned(depth) == v
	case int:
		return r.matches(int64(v), depth)
	case int64:
		if r.typ == 1 || r.typ == 2 || r.typ == 6 || r.typ == 7 {
			return r.owned(depth) == v
		}
		if r.typ == 3 || r.typ == 8 {
			n := r.owned(depth).(float64)
			return n >= -0x1p63 && n < 0x1p63 && int64(n) == v && float64(v) == n && !(n == 0 && math.Signbit(n))
		}
		return false
	case float64:
		if r.typ == 3 || r.typ == 8 {
			n := r.owned(depth).(float64)
			return n == v && (n != 0 || math.Signbit(n) == math.Signbit(v))
		}
		if r.typ == 1 || r.typ == 2 || r.typ == 6 || r.typ == 7 {
			n := r.owned(depth).(int64)
			return v >= -0x1p63 && v < 0x1p63 && int64(v) == n && float64(n) == v && !(v == 0 && math.Signbit(v))
		}
		return false
	case string:
		return (r.typ == 4 || r.typ == 5) && r.str() == v
	case []byte:
		return r.typ == 25 && bytes.Equal(r.bytes(), v)
	case *big.Int:
		if r.typ != 12 {
			return false
		}
		n, ok := r.owned(depth).(*big.Int)
		return ok && n.Cmp(v) == 0
	case Symbol:
		return r.typ == 12 && r.owned(depth) == v
	case []any:
		if r.typ == 9 || r.typ == 12 || !(r.typ >= 10 && r.typ <= 24 || r.typ == 36) || r.len() != len(v) {
			return false
		}
		for i, x := range v {
			if !r.item(i).matches(x, depth+1) {
				return false
			}
		}
		return true
	case map[string]any:
		if r.typ != 9 || r.len() != len(v) {
			return false
		}
		for k, x := range v {
			if !r.get(k).matches(x, depth+1) {
				return false
			}
		}
		return true
	default:
		return false
	}
}
