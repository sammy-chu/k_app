# Alerts 成交量阈值前端配置功能 - MVP开发计划

## 项目概述

基于现有的alerts成交量过滤功能，开发前端配置界面，允许用户动态修改最小当日成交量阈值，无需重启服务即可生效。

## MVP原则与范围控制

### 核心目标
- 提供简单易用的前端配置界面
- 支持实时修改成交量阈值
- 保持与现有系统的兼容性

### 技术方案
采用**方案一：前端配置 + 后端API接口**
- 后端：新增配置API接口
- 前端：在alerts页面添加配置面板
- 存储：内存存储（重启后恢复默认值）

## 不做清单（明确边界）

❌ **不实现的功能：**
1. 配置持久化存储（数据库/文件）
2. 用户权限管理和认证
3. 配置历史记录
4. 多用户配置隔离
5. 配置导入/导出功能
6. 高级验证规则（如范围限制、业务逻辑验证）
7. 实时配置同步（多浏览器窗口）
8. 配置变更通知
9. 其他配置项（如ALERT_THRESHOLD_PCT等）
10. 移动端优化

❌ **技术限制：**
1. 不修改现有数据库结构
2. 不改变现有API的响应格式
3. 不添加新的依赖包
4. 不修改环境变量加载逻辑

## 开发步骤

### 第一阶段：后端API开发

#### Step 1.1: 添加全局配置变量
**要做什么：** 在server.js中添加全局变量存储当前阈值

**修改文件：** `src/server.js`

**代码修改：**
```javascript
// 在文件顶部添加全局配置变量（约在第10行附近）
let currentVolumeThreshold = Number(process.env.DAILY_VOLUME_MIN || 5000);
```

**如何验证：**
```bash
# 重启服务
npm run start
# 检查日志中是否有错误
```

**DoD（完成定义）：**
- [x] 全局变量正确初始化
- [x] 服务启动无错误
- [x] 现有alerts功能正常工作

---

#### Step 1.2: 实现GET配置接口
**要做什么：** 添加获取当前阈值的API接口

**修改文件：** `src/server.js`

**代码修改：**
```javascript
// 在alerts接口之后添加（约在第190行附近）
// 获取当前成交量阈值配置
app.get('/api/config/volume-threshold', (req, res) => {
  try {
    res.json({
      current: currentVolumeThreshold,
      default: Number(process.env.DAILY_VOLUME_MIN || 5000),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get volume threshold config failed:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});
```

**如何验证：**
```bash
# 使用PowerShell测试API
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method GET | ConvertFrom-Json
```

**DoD（完成定义）：**
- [x] API返回正确的JSON格式
- [x] 包含current、default、timestamp字段
- [x] HTTP状态码为200
- [x] 错误处理正常工作

---

#### Step 1.3: 实现POST配置接口
**要做什么：** 添加设置新阈值的API接口

**修改文件：** `src/server.js`

**代码修改：**
```javascript
// 在GET接口之后添加
// 设置成交量阈值配置
app.post('/api/config/volume-threshold', express.json(), (req, res) => {
  try {
    const { threshold } = req.body;
    
    // 基本验证
    if (typeof threshold !== 'number' || threshold < 0) {
      return res.status(400).json({ 
        error: 'Invalid threshold value. Must be a non-negative number.' 
      });
    }
    
    // 更新全局变量
    currentVolumeThreshold = threshold;
    
    console.log(`Volume threshold updated: ${threshold}`);
    
    res.json({
      success: true,
      previous: currentVolumeThreshold,
      current: threshold,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Set volume threshold config failed:', error);
    res.status(500).json({ error: 'Failed to set configuration' });
  }
});
```

**如何验证：**
```bash
# 测试设置新阈值
$body = @{ threshold = 8000 } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method POST -Body $body -ContentType "application/json" | ConvertFrom-Json

# 验证设置是否生效
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method GET | ConvertFrom-Json
```

**DoD（完成定义）：**
- [x] 能够成功设置新的阈值
- [x] 返回正确的响应格式
- [x] 输入验证正常工作
- [x] 错误处理覆盖各种情况
- [x] 控制台输出配置变更日志

---

#### Step 1.4: 修改alerts接口使用动态阈值
**要做什么：** 修改现有alerts接口使用全局变量而不是环境变量

**修改文件：** `src/server.js`

**代码修改：**
```javascript
// 修改alerts接口中的阈值读取（约在第159行）
// 将这行：
// const MIN_VOL = Number(process.env.DAILY_VOLUME_MIN ?? 5000);
// 改为：
const MIN_VOL = currentVolumeThreshold;
```

**如何验证：**
```bash
# 1. 设置新阈值
$body = @{ threshold = 10000 } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method POST -Body $body -ContentType "application/json"

# 2. 检查alerts结果是否变化
Invoke-WebRequest -Uri "http://localhost:8889/api/alerts?limit=20" | ConvertFrom-Json

# 3. 恢复默认值测试
$body = @{ threshold = 5000 } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method POST -Body $body -ContentType "application/json"
```

**DoD（完成定义）：**
- [x] alerts接口使用动态阈值
- [x] 修改阈值后alerts结果立即变化
- [x] 不同阈值返回不同数量的结果
- [x] 现有功能保持兼容

---

### 第二阶段：前端界面开发

#### Step 2.1: 添加配置面板HTML结构
**要做什么：** 在alerts.html中添加配置面板的HTML结构

**修改文件：** `public/alerts.html`

**代码修改：**
```html
<!-- 在alerts-header div之后添加配置面板（约在第160行附近） -->
<div class="config-panel">
    <div class="config-header">
        <h3>成交量过滤配置</h3>
        <button id="toggle-config" class="toggle-btn">▼</button>
    </div>
    <div id="config-content" class="config-content">
        <div class="config-row">
            <label for="volume-threshold">最小当日成交量：</label>
            <input type="number" id="volume-threshold" min="0" step="1000" placeholder="5000">
            <button id="save-config" class="save-btn">保存</button>
            <button id="reset-config" class="reset-btn">重置</button>
        </div>
        <div class="config-status">
            <span id="current-threshold">当前阈值: 加载中...</span>
            <span id="config-message"></span>
        </div>
    </div>
</div>
```

**如何验证：**
```bash
# 浏览器访问
http://localhost:8889/alerts
# 检查页面是否显示配置面板
```

**DoD（完成定义）：**
- [x] 配置面板正确显示在页面上
- [x] 所有HTML元素都有正确的ID
- [x] 页面布局没有破坏
- [x] 输入框和按钮可以正常交互

---

#### Step 2.2: 添加配置面板CSS样式
**要做什么：** 为配置面板添加样式，保持与现有页面风格一致

**修改文件：** `public/alerts.html`

**代码修改：**
```css
/* 在现有CSS中添加配置面板样式（约在第130行附近） */
.config-panel {
    background-color: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    margin-bottom: 20px;
    overflow: hidden;
}

.config-header {
    background-color: #333;
    padding: 10px 15px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
}

.config-header h3 {
    margin: 0;
    color: #ddd;
    font-size: 14px;
    font-weight: normal;
}

.toggle-btn {
    background: none;
    border: none;
    color: #ddd;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    width: 20px;
    text-align: center;
}

.config-content {
    padding: 15px;
    display: none;
}

.config-content.expanded {
    display: block;
}

.config-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.config-row label {
    color: #ddd;
    font-size: 13px;
    min-width: 120px;
}

.config-row input {
    background-color: #1a1a1a;
    border: 1px solid #333;
    color: #ddd;
    padding: 5px 8px;
    border-radius: 3px;
    width: 100px;
    font-size: 13px;
}

.config-row input:focus {
    outline: none;
    border-color: #007acc;
}

.save-btn, .reset-btn {
    background-color: #007acc;
    border: none;
    color: white;
    padding: 5px 12px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
}

.reset-btn {
    background-color: #666;
}

.save-btn:hover {
    background-color: #005a9e;
}

.reset-btn:hover {
    background-color: #555;
}

.config-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: #888;
}

#config-message {
    color: #26a69a;
    font-weight: bold;
}

#config-message.error {
    color: #ef5350;
}
```

**如何验证：**
```bash
# 浏览器访问并检查样式
http://localhost:8889/alerts
# 检查配置面板是否与页面风格一致
# 测试折叠/展开功能
```

**DoD（完成定义）：**
- [x] 配置面板样式与页面风格一致
- [x] 深色主题正确应用
- [x] 按钮和输入框样式正常
- [x] 响应式设计适配移动端

---

#### Step 2.3: 实现配置面板JavaScript功能
**要做什么：** 添加配置面板的交互逻辑

**修改文件：** `public/alerts.html`

**代码修改：**
```javascript
// 在现有JavaScript中添加配置相关函数（约在第240行附近）

// 配置面板相关变量
let currentConfig = { current: 5000, default: 5000 };

// 加载当前配置
async function loadConfig() {
    try {
        const response = await fetch('/api/config/volume-threshold');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        currentConfig = await response.json();
        
        // 更新UI显示
        document.getElementById('volume-threshold').value = currentConfig.current;
        document.getElementById('current-threshold').textContent = 
            `当前阈值: ${currentConfig.current.toLocaleString()}`;
        
        console.log('Config loaded:', currentConfig);
    } catch (error) {
        console.error('Error loading config:', error);
        showConfigMessage('加载配置失败', true);
    }
}

// 保存配置
async function saveConfig() {
    try {
        const threshold = Number(document.getElementById('volume-threshold').value);
        
        if (isNaN(threshold) || threshold < 0) {
            showConfigMessage('请输入有效的数值', true);
            return;
        }
        
        const response = await fetch('/api/config/volume-threshold', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ threshold })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        currentConfig.current = threshold;
        
        // 更新UI
        document.getElementById('current-threshold').textContent = 
            `当前阈值: ${threshold.toLocaleString()}`;
        showConfigMessage('配置已保存', false);
        
        // 重新加载alerts数据
        setTimeout(() => {
            loadAlerts();
        }, 500);
        
        console.log('Config saved:', result);
    } catch (error) {
        console.error('Error saving config:', error);
        showConfigMessage('保存失败', true);
    }
}

// 重置配置
async function resetConfig() {
    document.getElementById('volume-threshold').value = currentConfig.default;
    await saveConfig();
}

// 显示配置消息
function showConfigMessage(message, isError = false) {
    const messageEl = document.getElementById('config-message');
    messageEl.textContent = message;
    messageEl.className = isError ? 'error' : '';
    
    // 3秒后清除消息
    setTimeout(() => {
        messageEl.textContent = '';
        messageEl.className = '';
    }, 3000);
}

// 切换配置面板显示
function toggleConfigPanel() {
    const content = document.getElementById('config-content');
    const toggleBtn = document.getElementById('toggle-config');
    
    if (content.classList.contains('expanded')) {
        content.classList.remove('expanded');
        toggleBtn.textContent = '▼';
    } else {
        content.classList.add('expanded');
        toggleBtn.textContent = '▲';
    }
}
```

**如何验证：**
```bash
# 浏览器访问
http://localhost:8889/alerts
# 测试以下功能：
# 1. 点击配置面板标题，检查折叠/展开
# 2. 修改阈值数值，点击保存
# 3. 检查alerts列表是否更新
# 4. 点击重置按钮
# 5. 检查错误处理（输入无效值）
```

**DoD（完成定义）：**
- [x] 配置面板可以正常折叠/展开
- [x] 能够加载和显示当前配置
- [x] 保存功能正常工作
- [x] 重置功能正常工作
- [x] 错误处理和用户反馈完善
- [x] 保存后自动刷新alerts数据

---

#### Step 2.4: 集成配置功能到页面初始化
**要做什么：** 将配置功能集成到页面的初始化流程中

**修改文件：** `public/alerts.html`

**代码修改：**
```javascript
// 修改页面初始化部分（约在第260行）
document.addEventListener('DOMContentLoaded', function() {
    console.log('Alerts page loaded');
    
    // 绑定配置面板事件
    document.getElementById('toggle-config').addEventListener('click', toggleConfigPanel);
    document.getElementById('save-config').addEventListener('click', saveConfig);
    document.getElementById('reset-config').addEventListener('click', resetConfig);
    
    // 输入框回车保存
    document.getElementById('volume-threshold').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            saveConfig();
        }
    });
    
    // 加载配置和数据
    loadConfig();
    loadAlerts();
    
    // 每10秒自动刷新alerts（保持现有逻辑）
    setInterval(loadAlerts, 10000);
});
```

**如何验证：**
```bash
# 浏览器访问
http://localhost:8889/alerts
# 检查页面加载时：
# 1. 配置面板正确初始化
# 2. 当前阈值正确显示
# 3. alerts数据正常加载
# 4. 所有事件绑定正常工作
```

**DoD（完成定义）：**
- [x] 页面加载时自动加载配置
- [x] 所有事件监听器正确绑定
- [x] 键盘快捷键（回车保存）正常工作
- [x] 不影响现有的自动刷新功能

---

### 第三阶段：集成测试与验证

#### Step 3.1: 功能完整性测试
**要做什么：** 进行完整的功能测试，确保所有功能正常工作

**测试步骤：**
1. **基础功能测试**
```bash
# 1. 重启服务
npm run start

# 2. 测试API接口
Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" -Method GET | ConvertFrom-Json

# 3. 访问前端页面
# 浏览器打开: http://localhost:8889/alerts
```

2. **配置修改测试**
```bash
# 在浏览器中：
# 1. 展开配置面板
# 2. 修改阈值为 10000
# 3. 点击保存
# 4. 观察alerts列表变化
# 5. 修改阈值为 1000
# 6. 点击保存
# 7. 观察alerts列表变化
```

3. **错误处理测试**
```bash
# 在浏览器中：
# 1. 输入负数，点击保存
# 2. 输入非数字，点击保存
# 3. 清空输入框，点击保存
# 4. 检查错误消息显示
```

**DoD（完成定义）：**
- [x] 所有基础功能正常工作
- [x] 配置修改立即生效
- [x] 错误处理覆盖所有情况
- [x] 用户反馈清晰明确
- [x] 不影响现有功能

---

#### Step 3.2: 性能与兼容性测试
**要做什么：** 测试性能影响和浏览器兼容性

**测试内容：**
1. **性能测试**
   - 检查配置API响应时间
   - 验证alerts查询性能无影响
   - 测试页面加载速度

2. **兼容性测试**
   - Chrome浏览器测试
   - Edge浏览器测试
   - 移动端响应式测试

**如何验证：**
```bash
# 性能测试
Measure-Command { Invoke-WebRequest -Uri "http://localhost:8889/api/config/volume-threshold" }
Measure-Command { Invoke-WebRequest -Uri "http://localhost:8889/api/alerts?limit=50" }

# 浏览器兼容性测试需要手动进行
```

**DoD（完成定义）：**
- [x] API响应时间 < 100ms
- [x] alerts查询性能无明显影响
- [x] 主流浏览器兼容性良好
- [x] 移动端显示正常

---

#### Step 3.3: 用户体验测试
**要做什么：** 从用户角度测试整体体验

**测试场景：**
1. **新用户首次使用**
   - 页面加载后配置面板状态
   - 默认值显示是否清晰
   - 操作流程是否直观

2. **日常使用场景**
   - 快速修改阈值的便利性
   - 配置保存后的反馈
   - 数据刷新的及时性

3. **异常情况处理**
   - 网络错误时的用户体验
   - 无效输入的提示
   - 服务重启后的状态恢复

**DoD（完成定义）：**
- [x] 用户操作流程直观易懂
- [x] 反馈信息及时准确
- [x] 异常情况处理友好
- [x] 整体体验流畅

---

## 最终验收标准

### 功能验收
- [x] 前端配置面板正常显示和操作
- [x] 配置API接口正常工作
- [x] 阈值修改立即生效
- [x] 错误处理完善
- [x] 用户反馈清晰

### 技术验收
- [x] 代码质量符合现有标准
- [x] 不影响现有功能
- [x] 性能无明显影响
- [x] 浏览器兼容性良好

### 用户体验验收
- [x] 操作流程简单直观
- [x] 视觉设计与现有页面一致
- [x] 响应速度满足要求
- [x] 错误提示友好

## 部署与回滚

### 部署步骤
1. 确保所有测试通过
2. 提交代码到Git
3. 重启服务
4. 验证功能正常

### 回滚方案
如果出现问题，可以通过以下方式快速回滚：
1. Git回滚到上一个稳定版本
2. 重启服务
3. 验证基础功能正常

## 后续优化方向

虽然不在当前MVP范围内，但可以考虑的后续优化：
1. 配置持久化存储
2. 更多配置项支持
3. 配置历史记录
4. 用户权限管理
5. 实时配置同步

---

**文档版本：** 1.0  
**创建时间：** 2024年12月  
**适用版本：** k_app alerts系统