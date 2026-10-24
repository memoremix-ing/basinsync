[differential-dataflow]: <https://docs.rs/differential-dataflow/latest/differential_dataflow/input/struct.InputSession.html>

# Z-set

A mapping from rows to integer weights. An insertion contributes `+1`, a
deletion `-1`, and an update retracts the old row and inserts its replacement.
Equal rows' weights add; zero weights disappear. This is the input model for
*Differential Dataflow*[^][differential-dataflow] and similar incremental queries.
