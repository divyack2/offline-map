# offline-map
fun maps that can be viewed offline!

## Chunked tile requests

Instead of one HTTP request per tile, the planner groups tiles that sit next to each other in the archive into chunks (≤ ~1 MB each) and fetches each chunk with a single range request.

Output of `node check-chunks.js`:

| Region        | Tiles | Chunks | Requests saved |
|---------------|------:|-------:|---------------:|
| East Village  |    24 |     10 |    2.4× fewer |
| Manhattan     |   395 |     49 |      8× fewer |
| Five boroughs | 3,677 |     99 |     37× fewer |
