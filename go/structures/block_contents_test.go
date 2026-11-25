package structures

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"testing"
)

func TestMixedBlockRangesAndChecksum(t *testing.T) {
	b, _ := NewBasin(NewMemoryStorage(), bytes.Repeat([]byte{42}, 32))
	prefix := make([]byte, 200003)
	for i := range prefix {
		prefix[i] = byte(i % 251)
	}
	suffix := bytes.Repeat([]byte{77}, 9000)
	rows := []PageInput{}
	for i := 0; i < len(suffix); i += 4096 {
		end := i + 4096
		if end > len(suffix) {
			end = len(suffix)
		}
		rows = append(rows, PageInput{big.NewInt(int64(i / 4096)), suffix[i:end]})
	}
	block, err := BuildMixedBlock(b, prefix, rows)
	if err != nil {
		t.Fatal(err)
	}
	root, err := VolumeFromBlocks(b, map[string]BlockRoot{"/file": block})
	if err != nil {
		t.Fatal(err)
	}
	expected := append(append([]byte{}, prefix...), suffix...)
	actual, err := ReadFile(b, root, "/file", false)
	if err != nil || !bytes.Equal(actual, expected) {
		t.Fatal("mixed file", err)
	}
	if !bytes.Equal(block.Digest, CRC64NVME(expected)) {
		t.Fatal("whole-file digest")
	}
	for _, at := range []int{0, len(prefix) - 11, len(prefix), len(expected) + 1} {
		a, z := at, at+33
		if a > len(expected) {
			a = len(expected)
		}
		if z > len(expected) {
			z = len(expected)
		}
		b.ClearCache()
		got, err := ReadRange(b, root, "/file", uint64(at), 33, true)
		if err != nil || !bytes.Equal(got, expected[a:z]) {
			t.Fatal("mixed range", at, err)
		}
	}
	if _, err := BuildMixedBlockWithPageSize(b, nil, nil, 0); err == nil {
		t.Fatal("accepted zero page size")
	}
}
func TestSharedChunkBoundaries(t *testing.T) {
	raw, err := os.ReadFile("../../tests/vectors/chunking.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Pattern string
		Seed    uint32
		Length  int
		Lengths []int
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		data := make([]byte, v.Length)
		x := v.Seed
		for i := range data {
			switch v.Pattern {
			case "random":
				x ^= x << 13
				x ^= x >> 17
				x ^= x << 5
				data[i] = byte(x >> 24)
			case "runs":
				data[i] = byte(1 + i/16384)
			}
		}
		chunks, err := ContentChunks(data, DefaultChunkPolicy())
		if err != nil {
			t.Fatal(err)
		}
		lengths := []int{}
		for _, chunk := range chunks {
			lengths = append(lengths, len(chunk))
		}
		if !reflect.DeepEqual(lengths, v.Lengths) {
			t.Fatal("chunk boundaries", lengths, v.Lengths)
		}
	}
}
