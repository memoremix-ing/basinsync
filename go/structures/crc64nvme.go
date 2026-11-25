package structures

import (
	"encoding/binary"
	"hash/crc64"
	"math/big"
	"math/bits"
)

var nvmeTable = crc64.MakeTable(0x9a6c9329ac4bc9b5)

func CRC64NVME(input []byte) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint64(out, crc64.Checksum(input, nvmeTable))
	return out
}
func applyCRC(columns *[64]uint64, value uint64) uint64 {
	var out uint64
	for value != 0 {
		out ^= columns[bits.TrailingZeros64(value)]
		value &= value - 1
	}
	return out
}

var nvmeShifts = func() [64][64]uint64 {
	var powers [64][64]uint64
	for bit := range powers[0] {
		v := uint64(1) << bit
		for range 8 {
			if v&1 != 0 {
				v = (v >> 1) ^ 0x9a6c9329ac4bc9b5
			} else {
				v >>= 1
			}
		}
		powers[0][bit] = v
	}
	for i := 1; i < 64; i++ {
		for bit, v := range powers[i-1] {
			powers[i][bit] = applyCRC(&powers[i-1], v)
		}
	}
	return powers
}()

func CombineCRC64NVME(left, right []byte, rightLength *big.Int) []byte {
	require(len(left) == 8 && len(right) == 8, "invalid CRC64NVME length")
	require(rightLength != nil && rightLength.IsUint64(), "invalid CRC64NVME range length")
	crc, n := binary.BigEndian.Uint64(left), rightLength.Uint64()
	for n != 0 {
		crc = applyCRC(&nvmeShifts[bits.TrailingZeros64(n)], crc)
		n &= n - 1
	}
	out := make([]byte, 8)
	binary.BigEndian.PutUint64(out, crc^binary.BigEndian.Uint64(right))
	return out
}
