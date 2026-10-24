[sqlite-vfs]: <https://www.sqlite.org/vfs.html>

# Virtual File System

A *VFS*[^][sqlite-vfs] supplies file operations such as reads, writes, truncation,
locking, and synchronization beneath a database's pager. It observes file bytes;
interpreting those bytes as committed rows requires additional database context.
