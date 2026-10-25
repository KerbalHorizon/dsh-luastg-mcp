# LuaSTG MCP bridge wire protocol (v1)

This is the contract between `dsh-luastg-mcp` (TypeScript, DSH side) and
`LuaSTGMcpBridge` (C#, editor side). The C# implementation is authoritative:
`Protocol/BridgeProtocol.cs`, `Server/TcpBridgeServer.cs`, `Server/BridgeRouter.cs`
and `Actions/TreeActions.cs`.

## Transport

- TCP on `127.0.0.1:8090` (the C# listener binds `IPAddress.Loopback` only).
- UTF-8, no BOM.
- Newline-delimited JSON: exactly one compact JSON object per line, terminated
  by `\n`. JSON strings escape embedded newlines, so a message is always one
  physical line.
- One request produces one response line. The C# server accepts several
  requests on one connection; the DSH client deliberately opens one connection
  per tool call and closes it after the response.

```
client ── {"action":"get_tree","path":"0","maxDepth":1}\n ──▶ editor
client ◀── {"status":"ok","document":{...},"tree":{...}}\n ── editor
```

## Envelope

Request:

```json
{ "action": "set_attribute", "path": "0/4/2", "name": "Comment", "value": "hello" }
```

- `action` is required, a string, trimmed, matched case-insensitively by the router.
- Other fields are action-specific.

Response:

```json
{ "status": "ok", ... }
```

- `status` is always a string.
- Success: `"ok"`; `ping` uses `"pong"`.
- Error: `{"status":"<code>","error":"human readable reason","details":{...}}`.
  `details` is optional and action-specific.
- An unhandled exception in a handler becomes
  `{"status":"error","error":"<exception message>"}`.

## Node paths

`NodePath` addresses nodes by position, because `TreeNode` has no stable id:

- `"0"` — first root node (`DocumentData.TreeNodes[0]`, normally the only one).
- `"0/2/1"` — `TreeNodes[0].Children[2].Children[1]`.
- An empty or missing `path` means `"0"` for `get_tree`.
- Every segment is a non-negative integer, parsed with invariant culture.
- Invalid paths return `node_not_found` with an explanatory `error` and
  `details.path`.
- Paths are **positional**: `insert_node` and `delete_node` shift the indexes of
  later siblings (and their descendants). A client must re-read the tree after a
  structural command. This is the reason `mcp-crud-test.ps1` cannot use "the old
  path still resolves" as proof that a node was not deleted.

`NodeSnapshot.Capture` gives each node a `path` computed during the walk, so the
client never has to build paths itself.

## Actions

### `ping`

```json
{"action":"ping"}
→ {"status":"pong","editor":"connected"}
```

### `editor_state`

Read-only summary of the active document; no tree.

```json
{"action":"editor_state"}
→ {
    "status": "ok",
    "editor": "connected",
    "document": { "name": "...", "path": "...", "extension": ".lstges", "dirty": false, "nodeCount": 42 }
  }
```

`no_document` when no tab is open.

### `get_tree`

Request fields (all optional):

| field | type | default | meaning |
|---|---|---|---|
| `path` | string | `"0"` | root of the returned subtree |
| `maxDepth` | integer | `0` | levels below the node; `0` = unlimited |
| `attributes` | boolean | `true` | include every attribute |

```json
{"action":"get_tree","path":"0/4","maxDepth":2,"attributes":true}
→ {
    "status": "ok",
    "document": {
      "name": "True Mugetsu",
      "path": "D:\\LuaSTG\\True Mugetsu.lstges",
      "extension": ".lstges",
      "dirty": false,
      "nodeCount": 1842
    },
    "tree": {
      "path": "0/4",
      "type": "Folder",
      "typeFullName": "LuaSTGEditorSharp.EditorData.Node.General.Folder",
      "text": "Enemies",
      "banned": false,
      "expanded": true,
      "selected": false,
      "canDelete": true,
      "attributeCount": 2,
      "childCount": 12,
      "attributes": [
        { "name": "Name", "value": "Enemies", "editWindow": "" }
      ],
      "children": [ ... ],
      "truncated": true
    }
  }
```

`type` is `TreeNode.GetType().Name` (`Folder`, `TaskWait`, `Comment`, ...), not the
`.lstges` `$type` shorthand (`General.Folder`); `typeFullName` carries the full .NET
name.

- `maxDepth` counts levels below the selected node: with `maxDepth: 1` the node
  and its direct children are present and each child that has grandchildren gets
  `"truncated": true`.
- `attributes: false` omits the `attributes` array but keeps `attributeCount`.
- `node_not_found` when the path does not resolve.

The DSH `luastg_get_nodes` tool wraps this response and adds `ok`, `source`,
`transport`, `endpoint`, `action`, `elapsedMs`, and the resolved `path` /
`maxDepth` / `attributes`.

### `set_attribute`

Request:

| field | type | required | meaning |
|---|---|---|---|
| `path` | string | yes | target node |
| `name` | string | yes | attribute caption (`AttrCap`), exact first then case-insensitive |
| `value` | any scalar | yes | new value; JSON `null` means `""`; non-strings use `JToken.ToString()` |
| `reveal` | boolean | no | false skips selecting/expanding the row |

```json
{"action":"set_attribute","path":"0/4/2","name":"Comment","value":"hello"}
→ {
    "status": "ok",
    "path": "0/4/2",
    "name": "Comment",
    "oldValue": "old",
    "newValue": "hello",
    "changed": true,
    "text": "hello"
  }
```

- The change goes through `EditAttrCommand`; no-op values return
  `"changed": false` and do not touch the undo stack or dirty flag.
- Unknown attribute:

```json
{
  "status": "unknown_attribute",
  "error": "node '0/4/2' (Comment) has no attribute 'Foo'",
  "details": {
    "path": "0/4/2",
    "nodeType": "Comment",
    "availableAttributes": ["Comment", "Code"]
  }
}
```

- Missing `value` is `bad_request`; the handler distinguishes an absent key from
  JSON `null`.
- The DSH `luastg_update_node` tool calls this once per attribute. It is
  intentionally not a transaction: each call is a separate editor command.

### `insert_node`

Request:

| field | type | required | meaning |
|---|---|---|---|
| `type` | string | yes | .NET class name (`Comment`, `TaskWait`, `Folder`) or full name. The DSH tool also accepts the `.lstges` shorthand (`General.Folder`) and reduces it to `Folder` before sending; the bridge itself only matches `Type.Name` / `Type.FullName`. |
| `parent` | string | no | parent path; default root `"0"` |
| `index` | integer | no | 0-based child index; default append |
| `after` / `before` | string | no | sibling anchor; wins over `parent`/`index` |
| `attributes` | object | no | initial values applied while detached |
| `reveal` | boolean | no | default true: expand ancestors and select the new row |

```json
{"action":"insert_node","parent":"0/4","index":0,"type":"Comment","attributes":{"Comment":"hello"}}
→ {
    "status": "ok",
    "path": "0/4/0",
    "type": "Comment",
    "typeFullName": "LuaSTGEditorSharp.EditorData.Node.General.Comment",
    "text": "hello",
    "parentPath": "0/4",
    "index": 0,
    "selected": true,
    "nodeCount": 1843
  }
```

- The node is built and its attributes applied **before** touching the tree, so
  a bad type/attribute leaves the document untouched.
- `parent.ValidateChild(newNode)` must pass; otherwise `validation_failed`.
- `index` outside `0..childCount` is `index_out_of_range` with `childCount`.
- Unknown type is `unknown_node_type` with `details.suggestions`.
- No plugin loaded is `no_plugin`.
- The command is `InsertAsChildCommand` / `InsertBeforeCommand` /
  `InsertAfterCommand`, so Undo removes the node and Redo restores it.

### `delete_node`

```json
{"action":"delete_node","path":"0/4/2"}
→ {
    "status": "ok",
    "path": "0/4/2",
    "type": "Comment",
    "text": "hello",
    "parentPath": "0/4",
    "index": 2,
    "nodeCount": 1842
  }
```

- Root: `cannot_delete` with `"the root node cannot be deleted"`.
- `[CannotDelete]` type: `cannot_delete`.
- Missing path: `node_not_found`.
- The response captures `type` / `text` before the node leaves the tree, which
  lets a test compare the removed node with whatever now occupies the path.

## Error statuses

| status | meaning |
|---|---|
| `ok` | success |
| `pong` | successful `ping` |
| `error` | unhandled handler exception |
| `bad_request` | JSON line was an object but fields are missing/invalid |
| `unknown_action` | no handler for `action` |
| `no_document` | no active editor tab |
| `no_tree` | active document has no root node yet |
| `node_not_found` | `path` does not resolve |
| `unknown_attribute` | `name` is not an attribute of the node |
| `unknown_node_type` | `type` is not known to the loaded editor plugin |
| `no_plugin` | no node plugin is loaded yet |
| `unsupported_node_type` | type has no `(DocumentData)` constructor |
| `node_creation_failed` | constructor threw |
| `validation_failed` | `parent.ValidateChild(newNode)` rejected the insert |
| `index_out_of_range` | insert index outside `0..childCount` |
| `insert_failed` | `AddAndExecuteCommand` returned false |
| `delete_failed` | `AddAndExecuteCommand` returned false |
| `cannot_delete` | root or `[CannotDelete]` |

`BridgeCommandError` in `src/bridge-client.ts` keeps the raw `status`,
`details` and response object; its message is
`<status>: <error> (details: <compact JSON, max 2000 chars>)`.

## DSH client behavior

- `BridgeClient` opens a fresh socket per request, writes one line, reads until
  the first `\n`, validates the JSON object and its `status`, then destroys the
  socket.
- Overall deadline: `timeoutMs` (default 5000, clamped to 100..60000). It covers
  connect + response.
- `AbortSignal` from the DSH tool execution destroys the socket immediately.
- Connection errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, ...) become
  `BridgeUnavailableError` with:
  `无法连接 LuaSTG 编辑器 MCP 桥接（host:port）：连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件。`
- No response before the deadline becomes `BridgeTimeoutError`.
- Invalid JSON / non-object / missing `status` becomes `BridgeProtocolError`.
- A non-`ok`/`pong` status becomes `BridgeCommandError`.
- A response line may not exceed 32 million characters (the client's safety bound).

## Tool → action mapping

| DSH tool | bridge action(s) |
|---|---|
| `luastg_get_nodes` | `get_tree` |
| `luastg_update_node` | one `set_attribute` per entry in `attributes` |
| `luastg_add_node` | `insert_node` |
| `luastg_apply_subtree` | `apply_subtree` when the bridge implements it; otherwise one `insert_node` per node, depth-first, plus one `delete_node` on the subtree root if anything fails |
| `luastg_delete_node` | `delete_node` |
| `luastg_update_script` | `set_attribute` with `name: "Code"` |

`apply_subtree` is **not** part of protocol v1: a stock `LuaSTGMcpBridge` answers
`unknown_action` for it. The DSH tool therefore probes it once per client,
remembers the refusal, and then builds the tree with `insert_node` calls, so a
clean editor works without any C# change. A future bridge that adds the action
can create the tree in one round trip and the tool switches back automatically.

`luastg_search_nodes` and `luastg_batch_update` are intentionally absent: the C#
bridge has no matching actions yet.
