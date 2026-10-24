[turso]: <turso.md>

# Logical frame

A *Turso*[^][turso] transaction's row-version recovery records, with framing and
checksums. Enabling portable logical changes also includes object names and
metadata for interpreting changes independently of internal table identifiers.
Native recovery consumes the recovery records against their original base image;
portable metadata alone does not prescribe identical page layouts.
