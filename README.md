# CF Music 使用指南

基于 **Cloudflare Pages + Pages Functions + GitHub** 的私有音乐库。

搜索试听、一键上传、歌单管理、静态 CDN 分发。所有数据存 GitHub 私有仓库，Cloudflare Pages 负责界面与逻辑，静态资源走 Pages 全球边缘缓存。

---

## 一、准备

需要：

1. **Cloudflare 账号**（[免费注册](https://dash.cloudflare.com/sign-up)）
2. **GitHub 账号**（[免费注册](https://github.com/signup)）
3. **一个域名**（可选，但国内访问强烈建议绑）

> 💡 没有域名也能先玩起来，`xxx.pages.dev` 在国内时好时坏，先用着看看，觉得好用再绑。

---

## 二、部署（约 15 分钟）

### 第 1 步：复制项目到自己账号

1. 打开 [github.com/oyz8/CF_Music](https://github.com/oyz8/CF_Music)
2. 点右上角绿色 **Use this template** → **Create a new repository**
3. 仓库名随便填（比如 `music`）
4. 选 **Private**（推荐）
5. 点 **Create repository**

> 📝 记下仓库名，格式是 `你的用户名/music`，后面要用。

### 第 2 步：生成 GitHub 访问令牌

1. GitHub → 右上角头像 → **Settings**
2. 左侧拉到最底 → **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. Repository access 选 **Only select repositories**，勾选刚才建的仓库
5. Permissions → **Contents** → **Read and write**
6. 生成，**复制这串 token**（只显示一次）

> ⚠️ 复制时不要带空格或换行。

### 第 3 步：在 Cloudflare 建站点

1. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选中刚才的仓库
3. 构建命令留空，**Build output directory 填 `public`**
4. **Save and Deploy**

### 第 4 步：关闭自动部署 ⚠️

1. Pages 项目 → **Settings**
2. **Builds & deployments** → **Automatic deployments** → **Disable**

> 不关的话，每次上传歌都会重新构建一次，白白浪费额度。

### 第 5 步：创建部署钩子

1. 同一个 Settings 页 → **Deploy hooks** → **Create**
2. 名字随便填（比如 `manual`），分支选 `main`
3. **复制生成的网址**

### 第 6 步：填写配置

Pages 项目 → **Settings** → **Environment variables**，添加：

| 名字 | 填什么 |
|---|---|
| `PASSWORD` | 自己设一个登录密码 |
| `GITHUB_TOKEN` | 第 2 步复制的那串 |
| `REPO_NAME` | 第 1 步记下的 `用户名/仓库名` |
| `CF_DEPLOY_HOOK_URL` | 第 5 步复制的网址 |

> 粘贴 `GITHUB_TOKEN` 时**不要按回车**，直接保存。

### 第 7 步：重新部署一次

Pages 项目 → **Deployments** → 最新那条 → **Retry deployment**，等 1 分钟。

此时访问 `xxx.pages.dev` 已经能用。测试一下功能是否正常。

### 第 8 步：绑定自定义域名（国内访问必做）

> 🎯 这一步决定你在国内能不能稳定访问。只在国内用、且能访问 `pages.dev` 的话可以跳过。

#### 情况 A：域名已托管在 Cloudflare（推荐）

1. Cloudflare → 你的域名 → **DNS**，确认右上角是绿色 ✅（已激活）
2. 回到 Pages 项目 → **Custom domains** → **Set up a custom domain**
3. 输入子域名，例如 `music.你的域名.com`
4. 点确认，Cloudflare 自动加 CNAME
5. 等 1 分钟，SSL 签发完成

#### 情况 B：域名在其他服务商（Namesilo / 阿里云 / 腾讯云等）

1. Cloudflare → **Websites** → **Add a site** → 输入你的域名
2. 按提示去域名商那改 **NS 服务器**为 Cloudflare 给的两个地址
3. 等 DNS 生效（几分钟到几小时）
4. 生效后，按 **情况 A** 的步骤 2-5 操作

> 💡 强烈建议用子域名（`music.你的域名.com`），不影响主域名其他用途。

### 第 9 步：开始用

浏览器打开你的域名，输入密码登录。

---

## 三、日常使用

### 搜歌

顶部搜索框输入歌名或歌手，选音源（默认 `netease`）和音质（默认 `320K`），点搜索。

### 试听

点搜索结果任意一行，左下角播放器自动播放。

### 上传到自己的音乐库

点搜索结果右侧 **上传** 按钮，等按钮变成「已上传」。

### 保存并部署

上传后**不会立刻生效**。点右上角 **保存并部署**，等 1-3 分钟。

> 💡 可以一次上传很多首，最后统一部署，省时间。

### 管理歌单

点 **歌单列表** 标签。新上传的歌排在最上面。

- 点一行 → 播放
- 点右侧 🗑 → 删除

删除后同样需要点 **保存并部署**。

---

## 四、外部调用（可选）

`/playlist` 是一个对外暴露的接口，把歌单以 JSON 格式提供给第三方使用（探针面板、个人网站、爬虫等）。

> 默认是**关闭**的——不配置白名单，任何人访问都返回 403。需要用才开。

### 1. 开启白名单

Pages 项目 → **Settings** → **Environment variables**，添加：

| 名字 | 填什么 |
|---|---|
| `ALLOWED_DOMAINS` | 允许访问的域名，多个用英文逗号分隔 |

例如：

```
music.example.com,blog.example.com,xxx.pages.dev
```

配好后 **Retry deployment** 一次生效。

**域名规则**：

- 只匹配主机名（不含 `https://` 和路径）
- 填 `example.com` 会同时放行 `example.com` 和 `www.example.com` 等所有子域
- 不配置 = 拒绝所有外部请求

### 2. 调用方式

在**白名单域名**的页面里发起请求：

```js
fetch('https://music.你的域名.com/playlist')
  .then(r => r.json())
  .then(list => console.log(list));
```

也可以用 `curl` 测试（需要手动带上 Referer）：

```bash
curl -H "Referer: https://music.example.com" \
     https://music.你的域名.com/playlist
```

### 3. 返回格式

```json
[
  {
    "name": "歌名",
    "artist": "歌手",
    "id": "歌曲ID",
    "source": "netease",
    "url": "https://music.你的域名.com/url/歌名 - 歌手.mp3",
    "pic": "https://music.你的域名.com/pic/歌名 - 歌手.jpg",
    "lyric": "https://music.你的域名.com/lrc/歌名 - 歌手.lrc"
  }
]
```

| 字段 | 说明 |
|---|---|
| `name` | 歌曲名 |
| `artist` | 歌手名（多歌手用 `、` 分隔） |
| `id` | 原音源的歌曲 ID |
| `source` | 音源（`netease` / `tencent` / ...） |
| `url` | 音频直链（可直接播放） |
| `pic` | 封面直链 |
| `lyric` | 歌词直链 |

### 4. 使用场景示例

**嵌入自己的网站做播放列表**：

```html
<script>
fetch('https://music.你的域名.com/playlist')
  .then(r => r.json())
  .then(list => {
    list.forEach(song => {
      console.log(song.name, song.url);
    });
  });
</script>
```

**给探针面板拉歌单**：

把 `/playlist` 地址填进探针的 API 配置里，通常探针会要求指定字段映射，对应到 `name` / `artist` / `url` 即可。

### 5. 常见问题

**Q：调用返回 403「禁止直接访问」？**

请求里没有 `Referer` 或 `Origin` 头。浏览器自动带，但 `curl` / Postman 需要手动加：

```bash
-H "Referer: https://music.example.com"
```

**Q：返回 403「域名未授权」？**

请求来源的域名不在 `ALLOWED_DOMAINS` 里。把它加进去，重新部署。

**Q：返回的 url 是 `xxx.pages.dev` 而不是我的域名？**

说明访问的入口是 `pages.dev`，而不是自定义域名。检查调用地址，应该用 `https://music.你的域名.com/playlist`。

**Q：想对所有人开放？**

把 `ALLOWED_DOMAINS` 设为 `*` **无效**。想开放只能靠调用方带正确的 Referer，或者另做一个不带防盗链的接口。**不推荐公开**，因为 URL 暴露后任何人都能拿到你的音频资源。

**Q：能只暴露给某个 IP？**

不支持。本接口只做域名级白名单，不做 IP 级。

---

## 五、常见问题

**Q：`xxx.pages.dev` 打不开？**

国内访问 `pages.dev` 时好时坏。绑自定义域名（第 8 步）可彻底解决。

**Q：上传后歌单没变化？**

点右上角「保存并部署」，等 1-3 分钟。

**Q：上传报「文件过大」？**

超过 50 MB。把音质从「无损」改成「320K」再试。

**Q：上传报「无音频」？**

这个音源没有这首歌的资源。换个音源，或降低音质再试。

**Q：搜索提示请求太频繁？**

等 1-2 分钟再搜。这是音乐源的限制，不是你的问题。

**Q：忘记密码了？**

Pages → Settings → Environment variables → 改 `PASSWORD` → 重新部署一次。

**Q：上传的歌点了没反应？**

刚上传还没部署。点「保存并部署」，等 1-3 分钟。

**Q：域名解析了但打不开？**

- Cloudflare 里域名是否已激活（绿色 ✅）
- Custom domains 里是否已绑定并显示 Active
- 等 5-10 分钟，DNS 生效需要时间

**Q：不想折腾域名怎么办？**

先用 `xxx.pages.dev` 顶一段时间。如果只是自己偶尔用，也够。

**Q：删除歌曲后还能播放？**

CDN 缓存最长 30 天。紧急下架需要在 Cloudflare → **Caching** → **Configuration** → **Purge Cache** → 输入完整 URL 手动清除。

---

## 六、注意事项

- **不要公开 GitHub 仓库地址** — 里面是你的音频文件
- **不要公开 `CF_DEPLOY_HOOK_URL`** — 别人拿到可以触发部署
- **密码设复杂一点** — 虽然只有自己用
- **无损音乐很容易超 50 MB** — 一般 320K 就够了
- **Git 自动部署已关闭** — 改代码后需要手动 Retry deployment
- **新增/删除歌曲需要点「保存并部署」** — 不会自动生效

---

## 免责声明

- 本项目为纯技术演示，不含任何音乐内容。
- 所有音频由使用者自行上传，存放在使用者自己的 GitHub 仓库。
- 使用者须确保上传内容**仅供个人学习使用**，禁止传播、分发、商用。使用本项目即视为自行承担版权、法律、数据、费用等全部风险。
- 作者不对使用者行为及由此产生的任何后果负责。
- 若不同意，请立即停止使用。

---

## 致谢

- 音乐源：[GD 音乐台](https://music.gdstudio.xyz)
- 托管：[Cloudflare Pages](https://pages.cloudflare.com)
