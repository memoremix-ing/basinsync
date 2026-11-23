[access-token]: <access-token.md>
[derived-subkey]: <derived-subkey.md>
[envbuf]: <envbuf.md>
[flexbuffers]: <flexbuffers.md>
[node-height]: <node-height.md>
[object-keys]: <../object-keys.md>

# Basin node

An opaque blob with transparent outgoing edges and an id composed of
*height*[~][node-height], version, *access token*[~][access-token] byte length,
and *derived subkey*[~][derived-subkey]; see the *node-id layout*[~][object-keys].

Complemented *heights*[~][node-height] put higher nodes first in S3 listings.
*Height*[~][node-height] zero suits
media and attachments; higher nodes commonly contain *EnvBuf-wrapped*[~][envbuf]
*FlexBuffers*[~][flexbuffers], but all contents may be encrypted end to end.
