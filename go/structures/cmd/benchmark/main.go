package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	s "github.com/memoremix-ing/basinsync/structures"
	"io"
	"os"
	"runtime/pprof"
	"time"
)

type Input struct {
	Entries     [][2]json.RawMessage
	Queries     []int
	Prefix      string
	PrefixCount int `json:"prefix_count"`
	Hot, Cold   int
}
type Store struct {
	*s.MemoryStorage
	Reads, Bytes int64
}

func (st *Store) Get(e s.Edge) ([]byte, error) {
	b, err := st.MemoryStorage.Get(e)
	st.Reads++
	st.Bytes += int64(len(b))
	return b, err
}
func check(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	if p := os.Getenv("TRIE_CPU_PROFILE"); p != "" {
		f, e := os.Create(p)
		check(e)
		check(pprof.StartCPUProfile(f))
		defer f.Close()
		defer pprof.StopCPUProfile()
	}
	raw, e := io.ReadAll(os.Stdin)
	check(e)
	var input Input
	check(json.Unmarshal(raw, &input))
	rows := []s.Entry{}
	for _, r := range input.Entries {
		var k string
		var v int64
		check(json.Unmarshal(r[0], &k))
		check(json.Unmarshal(r[1], &v))
		b, e := hex.DecodeString(k)
		check(e)
		rows = append(rows, s.Entry{Key: b, Value: v})
	}
	prefix, e := hex.DecodeString(input.Prefix)
	check(e)
	c := s.CountConsumer(7)
	warm, e := s.NewBasin(&Store{MemoryStorage: s.NewMemoryStorage()}, makeSeed())
	check(e)
	root, e := s.Build(warm, rows[:min(256, len(rows))], c)
	check(e)
	for j := 0; j < 256; j++ {
		i := j % min(256, len(rows))
		v, ok, e := s.Get(warm, root, rows[i].Key, 7)
		check(e)
		if !ok || v != rows[i].Value {
			panic("warm")
		}
	}
	st := &Store{MemoryStorage: s.NewMemoryStorage()}
	b, e := s.NewBasin(st, makeSeed())
	check(e)
	out := map[string]any{}
	phase := func(name string, run func()) {
		r, n := st.Reads, st.Bytes
		start := time.Now()
		run()
		out[name+"_ms"] = float64(time.Since(start).Nanoseconds()) / 1e6
		out[name+"_reads"] = st.Reads - r
		out[name+"_bytes"] = st.Bytes - n
	}
	phase("build", func() { root, e = s.Build(b, rows, c); check(e) })
	out["objects"] = len(st.Objects)
	size := 0
	for _, v := range st.Objects {
		size += len(v.Bytes)
	}
	out["stored_bytes"] = size
	out["height"] = root[3].(map[string]any)["height"]
	get := func(i int) {
		v, ok, e := s.Get(b, root, rows[i].Key, 7)
		check(e)
		if !ok || v != rows[i].Value {
			panic("get")
		}
	}
	for _, i := range input.Queries[:64] {
		get(i)
	}
	phase("hot", func() {
		for j := 0; j < input.Hot; j++ {
			get(input.Queries[j%64])
		}
	})
	phase("mixed", func() {
		for _, i := range input.Queries {
			get(i)
		}
	})
	phase("miss", func() {
		for _, i := range input.Queries {
			k := append(append([]byte{}, rows[i].Key...), 255)
			_, ok, e := s.Get(b, root, k, 7)
			check(e)
			if ok {
				panic("miss")
			}
		}
	})
	phase("cold", func() {
		for _, i := range input.Queries[:input.Cold] {
			b.ClearCache()
			get(i)
		}
	})
	phase("scan", func() {
		count, sum := 0, int64(0)
		check(s.Visit(b, root, nil, 7, func(any, any) bool { return true }, func(_ []byte, r s.Ref) (bool, error) {
			v, e := r.Value()
			if e != nil {
				return false, e
			}
			count++
			sum += v.(int64)
			return true, nil
		}))
		if count != len(rows) || sum != int64(count)*int64(count-1)/2 {
			panic("scan")
		}
	})
	count := 0
	phase("prefix", func() {
		check(s.Visit(b, root, prefix, 7, func(any, any) bool { return true }, func([]byte, s.Ref) (bool, error) { count++; return true, nil }))
		if count != input.PrefixCount {
			panic("prefix")
		}
	})
	phase("pruned", func() {
		for j := 0; j < 1000; j++ {
			check(s.Visit(b, root, prefix, 7, func(any, any) bool { return false }, func([]byte, s.Ref) (bool, error) { panic("unpruned") }))
		}
	})
	for _, n := range []int{1, 100} {
		phase(fmt.Sprintf("update%d", n), func() {
			changes := []s.Change{}
			for _, i := range input.Queries[:n] {
				changes = append(changes, s.Change{Key: rows[i].Key, Value: rows[i].Value.(int64) + int64(len(rows))})
			}
			next, e := s.Update(b, root, changes, c)
			check(e)
			v, ok, e := s.Get(b, next, rows[input.Queries[0]].Key, 7)
			check(e)
			if !ok || v != rows[input.Queries[0]].Value.(int64)+int64(len(rows)) {
				panic("update")
			}
		})
	}
	out["implementation"] = "go"
	out["prefix_count"] = count
	out["hot_ops"] = input.Hot
	out["mixed_ops"] = len(input.Queries)
	out["cold_ops"] = input.Cold
	check(json.NewEncoder(os.Stdout).Encode(out))
}
func makeSeed() []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = 42
	}
	return b
}
