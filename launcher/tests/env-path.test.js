'use strict';
/**
 * 环境目录路径规范化测试。
 *
 * 用法：node launcher\tests\env-path.test.js
 *
 * 保的是这条约定：环境目录默认必须跟随项目根，整个项目复制到别处后
 * env 要跟着走，而不是继续指着旧位置。
 */
const path = require('path');
const assert = require('assert');
const { normalizeEnv } = require(path.join(__dirname, '..', 'environment.js'));

const OLD = 'D:/Projects/Karaduoke';        // 原位置
const NEW = 'C:/Users/someone/Desktop/Karaduoke'; // 整个项目复制到桌面后

let passed = 0;
let failed = 0;

function check(name, root, input, wantValue, wantRebased) {
  try {
    const result = normalizeEnv(root, { dir: input, python: '', cache: '', bin: '' });
    assert.strictEqual(result.env.dir, wantValue, `值不对：${result.env.dir}`);
    assert.strictEqual(result.rebased, wantRebased, `rebased 标记不对：${result.rebased}`);
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

console.log('环境目录路径规范化');

check('留空 → 用默认的 <项目根>/env', NEW, '', '', false);
check('相对路径原样保留（统一分隔符）', NEW, 'runtime\\env', 'runtime/env', false);
check('项目根内的绝对路径 → 转相对', OLD, `${OLD}/env`, 'env', false);
check('项目根内的子目录 → 转相对', OLD, `${OLD}/env/cache`, 'env/cache', false);

// 用户实际遇到的场景：项目整个复制到桌面后，不该再指着 D 盘
check('复制到桌面后跟随新项目根', NEW, `${OLD}/env`, 'env', true);
check('复制到桌面后子目录也跟随', NEW, `${OLD}/env/python`, 'env/python', true);

// 用户真的把环境放在项目根之外时，保留绝对路径
check('项目根外的共享目录保留绝对路径', NEW, 'D:/Shared/models', path.normalize('D:/Shared/models'), false);
check('项目根外非 env 命名的目录保留', NEW, 'E:/Tools/bin', path.normalize('E:/Tools/bin'), false);

// 四个字段都要处理，不能只管 dir
{
  const result = normalizeEnv(NEW, {
    dir: `${OLD}/env`, python: '', cache: `${OLD}/env/cache`, bin: 'E:/Tools/bin',
  });
  try {
    assert.strictEqual(result.env.dir, 'env');
    assert.strictEqual(result.env.cache, 'env/cache');
    assert.strictEqual(result.env.bin, path.normalize('E:/Tools/bin'));
    assert.strictEqual(result.rebased, true);
    passed += 1;
    console.log('  ✓ 四个字段一起处理，互不干扰');
  } catch (error) {
    failed += 1;
    console.log(`  ✗ 四个字段一起处理\n      ${error.message}`);
  }
}

// 全部留空时不能报 changed，否则每次启动都会重写 config
{
  const result = normalizeEnv(NEW, { dir: '', python: '', cache: '', bin: '' });
  try {
    assert.strictEqual(result.changed, false, '空配置不该被判定为有改动');
    passed += 1;
    console.log('  ✓ 全空配置不触发回写');
  } catch (error) {
    failed += 1;
    console.log(`  ✗ 全空配置不触发回写\n      ${error.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
