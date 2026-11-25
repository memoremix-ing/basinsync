package structures

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestSharedLRUTraces(t *testing.T) {
	raw, err := os.ReadFile("../../tests/vectors/cache.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Scenarios []struct {
			Name                 string
			Capacity, ExtraBytes int
			Steps                [][]any
		}
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range cases.Scenarios {
		for rotate := 0; rotate < 3; rotate++ {
			s := NewMemoryStorage()
			writer := checked(NewBasin(s, bytes.Repeat([]byte{42}, 32)))
			roots := []Edge{}
			for i := 0; i < 3; i++ {
				roots = append(roots, checked(Build(writer, []Entry{{[]byte{0}, bytes.Repeat([]byte{byte(i)}, 32)}}, PlainConsumer())))
			}
			b := checked(NewBasin(s, bytes.Repeat([]byte{42}, 32)))
			b.MaxCacheBytes = scenario.Capacity*int(integer(field(roots[0][6], "length"))) + scenario.ExtraBytes
			for _, step := range scenario.Steps {
				edge := roots[(int(step[1].(float64))+rotate)%3]
				switch step[0].(string) {
				case "load":
					if _, err = b.Load(edge); err != nil {
						t.Fatal(err)
					}
				case "peek":
					r, e := b.Peek(edge)
					if e != nil || (r != nil) != step[3].(bool) {
						t.Fatal(scenario.Name, "peek", e)
					}
				case "clear":
					b.ClearCache()
				case "badLength":
					bad := append(Edge{}, edge...)
					f := map[string]any{}
					for k, v := range mapping(edge[6]) {
						f[k] = v
					}
					f["length"] = integer(field(f, "length")) + 1
					bad[6] = f
					if _, err = b.Load(bad); err == nil {
						t.Fatal("accepted wrong cached length")
					}
				}
				if s.Reads != int(step[2].(float64)) {
					t.Fatal(scenario.Name, "reads", s.Reads, step)
				}
			}
		}
	}
}
func TestLRUCountLimit(t *testing.T) {
	s := NewMemoryStorage()
	writer := checked(NewBasin(s, bytes.Repeat([]byte{42}, 32)))
	roots := []Edge{}
	for i := 0; i < 129; i++ {
		roots = append(roots, checked(Build(writer, []Entry{{[]byte{0}, bytes.Repeat([]byte{byte(i)}, 32)}}, PlainConsumer())))
	}
	b := checked(NewBasin(s, bytes.Repeat([]byte{42}, 32)))
	checked(b.Load(roots[0]))
	for _, edge := range roots[1:] {
		checked(b.Load(edge))
		if checked(b.Peek(roots[0])) == nil {
			t.Fatal("hot node evicted")
		}
	}
	if checked(b.Peek(roots[1])) != nil || s.Reads != 129 {
		t.Fatal("count limit", s.Reads)
	}
}
