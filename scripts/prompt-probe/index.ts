/**
 * 提示词探针总入口：四组按顺序跑，输出直接肉眼对照。
 *
 * 这不是产品代码：不进 build、不进安装包、不参与 typecheck（tsconfig 只收 src/**）。
 * 跑法：`npm run probe`（手工命令见 README.md）。
 *
 * 注意 ES import 会被提升，所以四组的执行顺序就是这里的书写顺序，
 * 分隔标题由各探针自己打印（不要在中间插 console.log，那样会全部排到最后）。
 */
import "./probe-prompt";
import "./probe-window";
import "./probe-materials";
import "./probe-local";
