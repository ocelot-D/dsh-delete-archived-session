## dsh-delete-archived-session
一个 DSH 插件：**列出并删除已归档的会话**。
DSH 本身只有「归档」和「取消归档」两个操作。**归档只是把会话藏起来，日志永远留在磁盘上**，官方没有任何办法把那块空间收回来。
### 安全设计

删会话就是把聊天记录销毁掉，所以这个插件刻意做得很保守。

1.只删已归档的。

2.必须明确确认。

3.必须先证明归属。

4.不跑出根目录。

5.默认可以恢复。

6.顺手清掉归档记录。

7.DSH不崩。

### 安装

这是一个标准的 DSH 插件包：`package.json` 里声明了 `dsh.bundle.patch`，`cordis.patch.yml` 负责插入一行。

**方法一（推荐）**：在对话里说一句「把这个插件装上」，让 AI 调用插件管理器安装。

**方法二**：自己手动加。在 profile 的 `package.json` 里加依赖并登记 bundle：

```json
{
  "dependencies": { "dsh-delete-archived-session": "file:./dsh-delete-archived-session" },
  "dsh": { "profile": { "bundles": ["dsh-delete-archived-session"] } }
}
```

装好后需要重启 DSH 才生效。

### 配置

插件**不导入 Node 标准库以外的任何东西**——它注册的是朴素的工具/命令描述对象，也不接受 schemastery 的 `Config`。这样做是为了不管 profile 怎么提升 DSH 自身的依赖，它都能挂载成功。

配置因此走环境变量：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_DELETE_ARCHIVED_SESSIONS_ROOT` | `$DSH_HOME/sessions` | 要操作的会话根目录 |
| `DSH_DELETE_ARCHIVED_SESSIONS_TRASH` | `<根目录>/../.deleted-sessions` | 删除时移入的回收站 |
| `DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT` | 不设（允许永久删除） | 设为 `0`、`false` 或 `no` 则禁止永久删除，强制走可恢复路径 |

`$DSH_HOME` 的读取方式和 DSH 本身一致：先看 `$DSH_HOME`，没有就用 `~/.dsh`。