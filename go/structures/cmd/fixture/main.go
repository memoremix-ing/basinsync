package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	s "github.com/memoremix-ing/basinsync/structures"
	"io"
	"math/big"
	"os"
	"sort"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	value, err := s.ParseJSON0(input)
	if err != nil {
		return err
	}
	req := value.(map[string]any)
	kind := req["kind"].(string)
	storage := s.NewMemoryStorage()
	seed := bytes.Repeat([]byte{42}, 32)
	if v, ok := req["seed"]; ok {
		seed = v.([]byte)
	}
	basin, err := s.NewBasin(storage, seed)
	if err != nil {
		return err
	}
	var result any
	if os.Args[1] == "build" {
		var root s.Edge
		if kind == "trie" {
			rows := []s.Entry{}
			for _, v := range req["entries"].([]any) {
				a := v.([]any)
				key, err := hex.DecodeString(a[0].(string))
				if err != nil {
					return err
				}
				rows = append(rows, s.Entry{Key: key, Value: a[1]})
			}
			root, err = s.Build(basin, rows, s.CountConsumer(7))
		} else if kind == "pages" {
			pages := []s.PageInput{}
			for _, v := range req["pages"].([]any) {
				a := v.([]any)
				pages = append(pages, s.PageInput{Index: a[0].(*big.Int), Bytes: a[1].([]byte)})
			}
			block, e := s.BuildBlock(basin, pages)
			if e != nil {
				return e
			}
			root, err = s.VolumeFromBlocks(basin, map[string]s.BlockRoot{"/sparse": block})
		} else {
			files := []s.FileInput{}
			for _, v := range req["files"].([]any) {
				a := v.([]any)
				files = append(files, s.FileInput{Path: a[0].(string), Bytes: a[1].([]byte)})
			}
			dirs := []string{}
			if v, ok := req["directories"]; ok {
				for _, d := range v.([]any) {
					dirs = append(dirs, d.(string))
				}
			}
			root, err = s.BuildVolume(basin, files, dirs...)
		}
		if err != nil {
			return err
		}
		objects := []any{}
		keys := []string{}
		for key := range storage.Objects {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			v := storage.Objects[key]
			objects = append(objects, []any{v.Edge, v.Bytes})
		}
		result = map[string]any{"kind": kind, "root": root, "objects": objects, "queries": req["queries"]}
	} else {
		for _, v := range req["objects"].([]any) {
			a := v.([]any)
			if err = storage.Restore(a[0].([]any), a[1].([]byte), nil); err != nil {
				return err
			}
		}
		root := req["root"].([]any)
		rows := []any{}
		if kind == "trie" {
			entries, err := s.Entries(basin, root, nil, 7)
			if err != nil {
				return err
			}
			for _, e := range entries {
				rows = append(rows, []any{hex.EncodeToString(e.Key), e.Value})
			}
		} else if kind == "pages" {
			for _, q := range req["queries"].([]any) {
				v, found, e := s.ReadPage(basin, root, "/sparse", q.(*big.Int), true)
				if e != nil {
					return e
				}
				var value any
				if found {
					value = v
				}
				rows = append(rows, []any{q, value})
			}
		} else {
			var walk func(string) error
			walk = func(dir string) error {
				names, err := s.List(basin, root, dir)
				if err != nil {
					return err
				}
				for _, name := range names {
					p := dir + "/" + name
					if dir == "/" {
						p = "/" + name
					}
					if _, err = s.List(basin, root, p); err == nil {
						rows = append(rows, []any{p, nil})
						if err = walk(p); err != nil {
							return err
						}
					} else {
						weak, err := s.ReadFile(basin, root, p, true)
						if err != nil {
							return err
						}
						strong, err := s.ReadFile(basin, root, p, false)
						if err != nil {
							return err
						}
						if !bytes.Equal(weak, strong) {
							return fmt.Errorf("shortcut mismatch")
						}
						rows = append(rows, []any{p, weak})
					}
				}
				return nil
			}
			if err = walk("/"); err != nil {
				return err
			}
		}
		keys := []string{}
		for _, v := range req["objects"].([]any) {
			e := v.([]any)[0].([]any)
			f := e[6].(map[string]any)
			pointer := map[string]any{"height": e[3].(map[string]any)["height"], "version": f["version"], "entropy": f["entropy"], "revision": f["revision"]}
			key, keyError := s.NodeKey(pointer, "old")
			if keyError != nil {
				return keyError
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		result = map[string]any{"kind": kind, "rows": rows, "query": root[3], "header": root[5]}
		result.(map[string]any)["keys"] = keys
	}
	out, err := s.JSON0(result)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(out)
	return err
}
