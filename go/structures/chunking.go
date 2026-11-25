package structures

// ChunkPolicy controls content boundaries independently of trie keys and storage.
type ChunkPolicy struct {
	Min, Target, Max  int
	Mixed, RunAnchors bool
}

func DefaultChunkPolicy() ChunkPolicy { return ChunkPolicy{16384, 65536, 262144, true, true} }
func ContentChunks(input []byte, p ChunkPolicy) (out [][]byte, err error) {
	defer protect(&err)
	require(p.Min > 0 && p.Min <= p.Target && p.Target <= p.Max && p.Target <= 1<<24 && p.Target&(p.Target-1) == 0 && p.Max <= 32<<20, "invalid chunk policy")
	var table [256]uint32
	x := uint32(0x9e3779b9)
	for i := range table {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		table[i] = x
	}
	start, run, last := 0, 0, -1
	hash := uint32(0)
	emit := func(end int) {
		out = append(out, append([]byte{}, input[start:end]...))
		start = end
		run = 0
		last = -1
		hash = 0
	}
	for at, b := range input {
		if p.RunAnchors && run >= 64 && last != int(b) && at-start >= p.Min {
			emit(at)
		}
		if last == int(b) {
			run++
		} else {
			run = 1
		}
		last = int(b)
		hash = (hash << 1) + table[b]
		boundary := hash
		if p.Mixed {
			boundary ^= boundary >> 16
			boundary *= 0x7feb352d
			boundary ^= boundary >> 15
			boundary *= 0x846ca68b
			boundary ^= boundary >> 16
		}
		used := at + 1 - start
		if used >= p.Max || (used >= p.Min && boundary&uint32(p.Target-1) == 0) {
			emit(at + 1)
		}
	}
	if start < len(input) {
		emit(len(input))
	}
	return out, nil
}
