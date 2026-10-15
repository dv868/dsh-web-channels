# 上游对照记录

核查日期：2026-10-15。

原项目：https://github.com/LittleCar30/dsh-deepseek-web

当前核对版本：dsh-deepseek-web-littlecar30 0.2.14。

本机升级安装包 SHA256：6679E8E2BEB3972082D4EE8B3619501877EF993B22EDE0F5E77878DC9FFF345A。
GitHub Release tgz 与 npm 同版本 dist.integrity（SHA512）一致。

已借鉴：辅助请求隔离、检查点接续、失败不推进游标、工具异常纠错、结束原因检查。
本项目额外方向：跨 Gemini / Perplexity 的会话恢复索引不存正文；通过 CDP 目标和回复哈希核对原标签；保留网页模型选择；网页 Markdown 结构保真。

不直接移植：DeepSeek DSML、DeepSeek SSE 字段、原项目 token 用量统计与压缩预算。
尚未实现：逐字流式、附件上传、独立交付审核、自动上游更新。

后续升级须读 README、CHANGELOG、ADVANCED，确认真实发行包及新旧包名，备份 profile，离线回归与真实网页验证后再安装。
不同时启用 dsh-deepseek-web 和 dsh-deepseek-web-littlecar30，不删除 DshDeepSeekWeb 登录目录。
