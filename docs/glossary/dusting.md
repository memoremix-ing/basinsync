[node]: <node.md>
[revision]: <revision.md>
[young-generation]: <young-generation.md>

# Dusting

Periodically LIST the *young generation*[^][young-generation] to locate objects
without a viable database allocation for their *node*[^][node] and
*revision*[^][revision], including objects recreated by late uploads after reclamation.
