[envbuf]: <envbuf.md>
[flexbuffers]: <flexbuffers.md>
[lexidecimal]: <lexidecimal.md>

# Range manifest

The final *EnvBuf*[^][envbuf] in a command sequence. Its
*FlexBuffers*[^][flexbuffers] payload indexes every preceding *envelope*[^][envbuf] by its
exclusive end offset in the containing object, encoded as positive
*Lexidecimal*[^][lexidecimal]:

```ts
[Symbol.species, "sync.memoremix.com", "sts/0/databasin/rangemanifest", {
  envelopes: { [lex_exclusive: string]: [Symbol.species, host, path] }
}]
```

Each value is a command prefix without its query payload. The manifest omits
itself; locate it by reading backward from the object's final footer.
