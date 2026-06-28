---
title: "嵌入式开发者视角的 Google C++ Style Guide 实战解读"
date: 2025-12-11T12:00:00+08:00
categories: ["嵌入式"]
tags: ["C++", "代码规范", "软件工程"]
cover: /images/google-cpp-style-guide-embedded/google-style-cover.png
top_img: false
---

## 一、这东西到底有什么用？

2013 年 Google 把内部 C++ 规范扔上了 GitHub。现在 38000+ Star，Chromium 在用，LLVM 在参考，国内大厂的规范里也多多少少能看到它的影子。

但它从一开始就没打算当"温和的建议"。它**禁异常、禁 RTTI、禁 C 风格转型、禁全局变量、禁静态存储期对象**。每一条单独拎出来都能在技术群里吵一个下午。

这些规则背后有一个简单的事实：这份规范是为 100M+ 行代码、上万工程师、维护几十年的代码库写的。这个场景跟嵌入式出奇地像——二进制要小、控制流要稳、出问题不能靠抛异常甩锅。

我不是来翻译官方文档的。下面从写了几十万行嵌入式 C/C++ 的经验出发，拆哪些能直接用、哪些得改改、哪些 Google 自己也没那么认真。

![Google C++ Style Guide](/images/google-cpp-style-guide-embedded/google-style-cover.png)

---

## 二、核心哲学：为什么偏要优化给"读者"看？

Google Style 的第一句话就能劝退不少人：

> **Optimize for the reader, not the writer.**

说白了：写的时候多花 5 秒，让别人（以及三个月后的你自己）读的时候省 5 分钟。

### 这在嵌入式项目里意味着什么？

拿一段典型的裸机按键扫描代码对比：

**Before**

```c
uint8_t k;
uint8_t p;
uint8_t s;
int c;
void scan() {
    for (k = 0; k < 8; k++) {
        p = read(0x50 + k);
        s = p ^ 0xFF;
        if (s != 0 && s != last[k]) {
            c = __builtin_ctz(s);
            if (s > last[k])
                cb_press(k, c);
            else
                cb_release(k, c);
            last[k] = s;
        }
    }
}
```

这段代码是编译器能跑的，但三个月后的维护者在凌晨三点看到 `p = read(0x50 + k)` 的时候，心态是崩溃的：`0x50` 是什么寄存器？`s` 是什么？`cb_press` 的参数类型是什么？

**After — Google Style + 嵌入式惯例**

```c
typedef enum {
    KEY_EVENT_PRESS = 0,
    KEY_EVENT_RELEASE = 1,
} KeyEvent;

typedef void (*KeyCallback)(uint8_t row, uint8_t col, KeyEvent event);

static constexpr uint8_t kKeyMatrixBaseAddr = 0x50;
static constexpr uint8_t kKeyMatrixRows = 8;
static constexpr uint8_t kKeyMatrixMask = 0xFF;

static uint8_t g_key_last_state[kKeyMatrixRows];
static KeyCallback g_key_callbacks[kKeyMatrixRows][8];

void KeyMatrix_Scan(void) {
    for (uint8_t row = 0; row < kKeyMatrixRows; row++) {
        const uint8_t raw_state = GPIO_ReadPort(kKeyMatrixBaseAddr + row);
        const uint8_t inverted_state = raw_state ^ kKeyMatrixMask;

        if (inverted_state == g_key_last_state[row])
            continue;

        for (uint8_t col = 0; col < 8; col++) {
            const uint8_t bit_mask = 1U << col;
            const bool was_pressed = g_key_last_state[row] & bit_mask;
            const bool is_pressed = inverted_state & bit_mask;

            if (is_pressed == was_pressed)
                continue;

            const KeyEvent event = is_pressed ? KEY_EVENT_PRESS : KEY_EVENT_RELEASE;
            if (g_key_callbacks[row][col] != NULL)
                g_key_callbacks[row][col](row, col, event);
        }

        g_key_last_state[row] = inverted_state;
    }
}
```

同样的功能，代码量多了，但任何一个 C 程序员打开都能在 10 秒内理解逻辑——这就是"为读者优化"的实战价值。

### 三条黄金法则

| 原则 | 含义 | 嵌入式举例 |
|------|------|-----------|
| 一致性压倒个人偏好 | 团队用一种风格，哪怕你不喜欢 | 别争论缩进用 2 格还是 4 格，定下来就别改 |
| 尽量避免"聪明"特性 | 禁止异常、RTTI、全局对象构造函数 | STM32 启动阶段 CRTP 全局对象初始化顺序是 UB |
| 自动化优先 | `clang-format` + `clang-tidy`，别手动查风格 | CI 上挂一个 lint 检查，不通过不能合 |

---

## 三、命名规范：代码即文档的第一公里

Google Style 的命名体系用视觉信号区分变量类型——扫一眼就知道是局部变量还是类成员、是函数还是常量。对于嵌入式 C 项目来说，这套规则能直接消灭最常见的命名问题。

### 完整命名速查表

| 实体 | 风格 | 示例 |
|------|------|------|
| 类 / 结构体名 | 大驼峰 | `class AdcDriver;` |
| 枚举类型名 | 大驼峰 | `enum class SensorState;` |
| 函数 / 方法名 | 大驼峰 | `void ReadSensorData();` |
| 普通变量（局部/参数） | 全小写下划线 | `int adc_value;` |
| 类成员变量 | 全小写下划线 + 尾部下划线 | `int buffer_size_;` |
| 结构体成员变量 | 全小写下划线，无后缀 | `std::string name;` |
| 常量（`constexpr` / `const`） | `k` + 大驼峰 | `const int kMaxBufferSize = 256;` |
| 枚举值 | `k` + 大驼峰 | `kErrorTimeout, kOk` |
| 宏 | 全大写 + 下划线 | `#define MYPROJECT_ROUND(x)` |
| 命名空间 | 全小写下划线 | `namespace sensor_driver {}` |
| 文件名 | 全小写下划线 | `adc_driver.h`, `adc_driver.cc` |

### 嵌入式实战中的几个关键点

**1. 类成员变量 vs 结构体成员变量**

这个区别非常重要：类有不变式（invariant），数据成员必须私有，因此尾部加 `_` 提醒"这是类内部状态，外面别碰"；结构体只是数据容器，成员不加后缀。

```cpp
class AdcDriver {
 private:
    uint8_t channel_;        // 私有 — 尾部有 _
    uint32_t sample_rate_;   // 私有 — 尾部有 _

 public:
    void StartConversion();
};

struct AdcConfig {
    uint8_t channel;         // 公开 — 无后缀
    uint32_t sample_rate;    // 公开 — 无后缀
};
```

**2. 常量的 `k` 前缀**

很多嵌入式项目用 `#define` 或全大写常量来区分可变与不可变。`k` 前缀是一种更轻量的视觉提示：

```cpp
// 一眼区分：可变 vs 不可变
int retry_count = 0;                // 普通变量
constexpr int kMaxRetryCount = 3;   // 编译期常量

if (retry_count < kMaxRetryCount) {
    retry_count++;
}
```

**3. 宏必须全大写**

这几乎是所有规范的共识——宏不遵循作用域规则，必须用大写字母划清界限：

```cpp
// ✅ 宏全大写 + 项目前缀
#define EMBEDMQ_FNV_OFFSET_BASIS 0x811c9dc5U
#define EMBEDMQ_HASH(topic) FNV1a((topic), sizeof(topic) - 1)

// ❌ 绝对禁止 — 和函数名完全混淆
#define hash(topic) FNV1a((topic), sizeof(topic) - 1)
```

---

## 四、头文件管理：嵌入式编译速度的命门

嵌入式项目编译慢的根源几乎永远是头文件依赖爆炸。一个 `.c` 文件 `#include "main.h"`，`main.h` 再拖着几十个 HAL 头文件——改一行宏，全项目重编。

Google Style 的头文件规则恰好对症下药。

### 规则 1：头文件必须自给自足

每个 `.h` 必须能**独立编译**——它自己 `#include` 它所依赖的一切。

```cpp
// sensor_manager.h
#ifndef SENSOR_MANAGER_H_
#define SENSOR_MANAGER_H_

#include <cstdint>          // 用了 uint32_t，必须自己包含
#include "adc_driver.h"     // 用了 AdcDriver，必须自己包含

class SensorManager {
 public:
    void Initialize();
    uint32_t ReadTemperature(const AdcDriver &adc);
};

#endif  // SENSOR_MANAGER_H_
```

验证方法：写一个 `.cc` 文件，第一行只 `#include` 你自己的头文件，能编译通过就说明合格。

### 规则 2：`#include` 顺序不是玄学

标准顺序：

```
1. 相关头文件（如 foo.cc 的 foo.h）
2. （空行）
3. C 标准库头文件
4. （空行）  
5. C++ 标准库头文件
6. （空行）
7. 其他第三方库
8. （空行）
9. 本项目头文件
```

```cpp
// adc_manager.cc — Include 顺序示例

#include "adc_manager.h"        // ① 对应头文件最先，充当自包含性检查

#include <stdint.h>             // ② C 库
#include <string.h>

#include <array>                // ③ C++ 库
#include <memory>

#include "stm32f4xx_hal.h"      // ④ 平台/HAL 层
#include "freertos/FreeRTOS.h"

#include "project_config.h"     // ⑤ 本项目头文件
#include "utils/debug_log.h"
```

把对应头文件放在第一位是最聪明的设计——如果 `adc_manager.h` 漏掉了某个 `#include`，`adc_manager.cc` **立刻报错**。这是一种零成本的持续集成检查。

### 规则 3：谨慎使用前置声明

Google 明确说：**避免用前置声明代替 `#include`**。前置声明会让依赖关系不可见、可能导致对象布局错误、刷新代码时改变语义。

唯一的例外：你真的只需要声明指针/引用类型，且头文件包含会引入巨大的编译依赖链。这种情况下在前置声明旁加注释说明原因。

### 嵌入式特例：预编译头文件

很多 MCU IDE（如 STM32CubeIDE、Keil）会自动把 `stm32f4xx_hal.h` 塞进每个源文件。但 Google Style 的世界里，**每个文件应该只包含它真正需要的头文件**。如果你用 CMake + GCC 构建嵌入式项目，建议：

```cpp
// ❌ — 拖慢编译
#include "hal_all.h"  // 包含全部 HAL 模块，哪怕你只用 GPIO

// ✅ — 按需包含
#include "hal_gpio.h"
#include "hal_uart.h"
```

---

## 五、类 vs 结构体：嵌入式 C++ 最需要搞清的界限

Google Style 对 `class` vs `struct` 的定义非常清晰：

| | `struct` | `class` |
|------|------|------|
| 用途 | 被动数据载体（无不变式） | 封装状态 + 行为 |
| 成员 | 全部 `public`，无后缀 | 全部 `private`，尾部 `_` |
| 方法 | 可以有：构造函数、`Reset()`、`IsValid()` | 所有业务逻辑 |
| 继承 | 基本不用 | OK |

### 嵌入式里的典型用法

```cpp
// struct — 纯数据，打包传给 ISR 或 DMA
struct AccelerometerSample {
    int16_t x;
    int16_t y;
    int16_t z;
    uint32_t timestamp_ms;
};

// class — 封装复杂的传感器驱动
class Mpu6050Driver {
 public:
    bool Init(I2C_HandleTypeDef *i2c);
    bool ReadAccel(AccelerometerSample *out);

 private:
    I2C_HandleTypeDef *i2c_handle_;
    uint8_t device_addr_;
    bool initialized_;
};
```

这条规则在嵌入式项目里尤其有用——它迫使你区分"数据"和"逻辑"，自然导向更清晰的模块边界。

### 设计原则：组合 > 继承

Google 强烈偏好组合而非继承。在嵌入式里这一点更加重要——多重继承在 MCU 上不仅浪费 ROM，还会带来 vtable 开销。

```cpp
// ❌ 为了一点点复用引入深层继承
class TemperatureSensor : public I2cDevice,
                           public PollableDevice,
                           public CalibratableDevice {
    // 调度器不确定，vtable 三份，调试地狱
};

// ✅ 组合 — 职责清晰
class TemperatureSensor {
 public:
    void Init(I2C_HandleTypeDef *i2c) { i2c_device_.Init(i2c, kAddr); }
    float Read() { return Calibrate(i2c_device_.ReadReg(kRegTemp)); }

 private:
    I2cDevice i2c_device_;
    float Calibrate(uint16_t raw);
};
```

---

## 六、函数与参数：在栈上传递意图

### 传参约定——一张表就够了

| 意图 | 传入参数类型 | 返回值 |
|------|------------|--------|
| 只读（无所有权） | `const T&` 或 `const T*` | `T` 或 `bool` |
| 要修改（无所有权） | `T*`（非空） | `void` 或 `bool` |
| 转移所有权 | `std::unique_ptr<T>` | — |
| 共享所有权 | `std::shared_ptr<T>` | — |

### 嵌入式里的参数传递

在 MCU 上，`std::unique_ptr` 和 `std::shared_ptr` 基本用不上——没有堆分配器。嵌入式 C++ 里的所有权几乎总是**单例模式**或**栈上静态分配**。

```cpp
// ✅ 嵌入式风格的"所有权"——编译期就定死了
class MotorController {
 public:
    // 不拥有 i2c — 只是引用，由 HAL 层管理生命周期
    void Init(I2C_HandleTypeDef *i2c) { i2c_ = i2c; }

    // 拥有 config — 内部拷贝一份
    void Configure(const MotorConfig &config) { config_ = config; }

 private:
    I2C_HandleTypeDef *i2c_;   // 不拥有
    MotorConfig config_;        // 拥有
};
```

### 函数声明注意事项

- **短函数可以 inline**（Google Style 限制 ≤ 10 行）。嵌入式里编译器 `__attribute__((always_inline))` 也很常见，但交给编译器决定更好。
- **输出参数用指针而不是引用**——这是 Google Style 的强烈建议，因为指针在调用处更显眼：

```cpp
// 调用处理后的返回值：status 是指针，调用处一眼可见会被修改
bool ProcessFrame(const Frame &input, Frame *output, Error *status);

// 调用处：
// Frame output;
// Error err;
// ProcessFrame(input, &output, &err);  ← & 提醒：会被修改
```

---

## 七、禁止异常：嵌入式早就不玩了

Google Style 第一条严格限制就是**彻底禁止 C++ 异常**。原因不分平台：

1. 异常导致非局部控制流——代码里看不出哪里会"跳出来"
2. 关闭异常（`-fno-exceptions`）后，二进制体积通常减少 15-20%
3. 异常安全代码需要大量 RAII 包装，增加认知负担

在嵌入式领域，禁止异常几乎是默认选项。大部分 MCU 工具链的 `libstdc++` 或 `libc++` 根本就不支持异常展开。如果你开启 `-fexceptions`，链接器会报一堆未定义符号。

### 替代方案：错误码 + 工厂函数

```cpp
// 构造函数失败——不能用异常，用工厂函数
class RingBuffer {
 public:
    static std::optional<RingBuffer> Create(size_t size) {
        uint8_t *buf = static_cast<uint8_t *>(malloc(size));
        if (buf == nullptr) return std::nullopt;
        return RingBuffer(buf, size);
    }

 private:
    RingBuffer(uint8_t *buf, size_t size) : buf_(buf), size_(size) {}
    uint8_t *buf_;
    size_t size_;
};

// 使用处 — 错误路径显式可见
auto rb = RingBuffer::Create(1024);
if (!rb.has_value()) {
    // 处理分配失败
    return;
}
```

在更裸的 MCU 环境（C++17 不可用），直接用 C 风格返回值：

```cpp
enum class RingBufferError {
    kOk = 0,
    kNullPointer = 1,
    kOutOfMemory = 2,
    kFull = 3,
};

RingBufferError RingBuffer_Init(RingBuffer *rb, uint8_t *buf, size_t size);

// 调用处
RingBufferError err = RingBuffer_Init(&rb, buffer, sizeof(buffer));
if (err != RingBufferError::kOk) {
    ErrorHandler(err);
    return;
}
```

---

## 八、类型转换：别用括号硬搞

嵌入式的 HAL 层到处都是 `(uint8_t *)&some_struct`、`(uint32_t)ptr`。Google Style 对类型转换的要求非常严格——但嵌入式有特例。

### Google 要求

```cpp
// ❌ Google 禁止 C 风格转换
int y = (int)x;
char *p = (char *)buffer;

// ✅ 使用 C++ 风格转换
int y = static_cast<int>(x);
char *p = reinterpret_cast<char *>(buffer);
```

### 嵌入式妥协

在和外设寄存器、DMA 缓冲区、链接脚本符号打交道时，类型转换不可避免。我的建议是：

**在 HAL/驱动层**：允许 C 风格转换（ST HAL 库本身就大量使用），但加注释说明：

```cpp
// OK — 硬件寄存器地址，必须强转
#define GPIOA_BASE ((uint32_t)0x40020000)     // 地址常量
GPIO_TypeDef *gpioa = (GPIO_TypeDef *)GPIOA_BASE;  // 寄存器映射
```

**在应用逻辑层**：严格使用 C++ 风格转换：

```cpp
auto ticks = static_cast<TickType_t>(timeout_ms / portTICK_PERIOD_MS);
auto *payload = reinterpret_cast<const uint8_t *>(&data);
```

---

## 九、格式化：别用手工排版

Google Style 的格式化规则用 `clang-format` 一键搞定。核心规则：

| 规则 | 值 |
|------|-----|
| 行宽 | ≤ 80 字符 |
| 缩进 | 2 空格（绝不用 Tab） |
| 大括号 | K&R 变体 — 控制流同行，函数/类另起行 |
| 指针/引用 | `int* x;` 或 `int *x;`，文件内保持一致 |

### `.clang-format` 配置文件

在项目根目录放一个：

```yaml
BasedOnStyle: Google
ColumnLimit: 80
IndentWidth: 2
UseTab: Never
AccessModifierOffset: -1
AllowShortFunctionsOnASingleLine: Inline
```

### 嵌入式 CI 集成

在 CI 脚本里加一行：

```bash
clang-format --dry-run --Werror source/**/*.cc source/**/*.h
```

任何格式不合格的代码直接 **-Werror** 退出，不要等人手动检查。

---

## 十、宏：Google 说禁止，嵌入式说离不开

这是 Google Style 和嵌入式最大的分歧点。Google 说"宏几乎总能被内联函数、`constexpr` 或枚举替代"——在 Linux 应用层确实如此。但嵌入式代码里：

```cpp
// 寄存器位操作 — 宏是唯一干净的选择
#define GPIO_SET_PIN(port, pin)   ((port)->BSRR = (1U << (pin)))
#define GPIO_CLEAR_PIN(port, pin) ((port)->BRR  = (1U << (pin)))

// 链接脚本符号 — 不是 C++ 类型系统能表达的
#define __VECT_TAB_BASE 0x08000000U
#define __STACK_TOP     0x20020000U
```

### 妥协策略

**可以继续用宏的场景：**

- 寄存器位操作
- 链接脚本符号的外漏常量
- 硬件地址常量映射
- `#ifdef` 条件编译（不同 MCU 系列的差异化代码）

**应该替换成 C++ 的场景：**

```cpp
// ❌ 功能宏 — 用 constexpr 替换
#define MAX(a, b) ((a) > (b) ? (a) : (b))

// ✅
template <typename T>
constexpr T Max(T a, T b) { return a > b ? a : b; }

// ❌ 调试宏 — 用 constexpr 变量替换
#define DEBUG_UART_BAUDRATE 115200

// ✅
constexpr uint32_t kDebugUartBaudrate = 115200;
```

**必须遵守的底线：**

- 宏名称全部大写，加项目前缀
- 多语句宏必须 `do { ... } while (0)` 包裹
- 宏内参数用括号

---

## 十一、全局变量：Google 说禁止，嵌入式确实要妥协

Google Style 对全局变量（包括 `static` 存储期对象）非常严格。但在裸机和 RTOS 环境下，全局状态是设计的一部分——任务通信、设备句柄、系统状态都必须跨函数存在。

### 嵌入式里的"安全全局变量"

```cpp
// ✅  文件作用域 static — 不对外可见
static AdcDriver g_adc1;
static SemaphoreHandle_t g_data_semaphore;

// ✅  命名空间 + 访问控制 — 对外刻意暴露
namespace SystemState {
    bool IsCalibrated();
    void SetCalibrated(bool calibrated);
}

// ❌ 裸露的全局 — 任何文件都能读写
bool g_system_calibrated;  // 坏味道
```

**核心原则**：如果不得不使用全局变量，把它锁在最小作用域里——`static` 文件作用域或 `namespace` + 函数封装。

---

## 十二、纯 C 项目：Google 风格怎么落地？

上面的讨论以 C++ 为主，但嵌入式圈有大量纯 C 项目——FreeRTOS、uC/OS、contiki、各种 MCU BSP 全是 C。

Google 没有独立的 "C Style Guide"。C 代码在 Google 内部遵循同一份 C++ Guide，把类、异常、模板那堆 C++ 专用的规则摘掉就是。C 代码的命名、格式、头文件管理，跟 C++ 版完全相同。

但对于嵌入式 C 项目，有几个地方值得单独展开。

### C 的命名要不要加 `g_` 前缀？

Google Style 没提 `g_`，但嵌入式 C 社区大量使用：

```c
// 匈牙利命名变体：g_ 全局、s_ 静态、p_ 指针
static uint8_t s_key_last_state[8];  // 文件作用域 static
UART_HandleTypeDef *g_huart1;        // 全局可见
```

这套命名法不是 Google 规范，但它在裸机 C 项目里很实用——没有命名空间，没有类，作用域全靠前缀区分。我的建议：团队内部统一就行，不必强求 Google 原版。

### C 没有命名空间怎么办？

命名空间是 Google Style 里最重要的隔离手段之一。纯 C 没有这个概念，替代方案是**函数名前缀**：

```c
// ❌ 裸函数名——链接时容易撞
void Init(void);
void Read(float *out);
void Reset(void);

// ✅ 模块前缀——C 的"命名空间"
void TempCtrl_Init(void);
void TempCtrl_Read(float *out);
void TempCtrl_Reset(void);
```

对于每个模块，统一一个 2-4 字符的前缀或模块全名。别心疼那点打字时间，换来的是全局搜索时一眼定位。

### C 的 `struct` 怎么玩？

Google Style 下，C++ 的 struct 就是纯数据容器。C 语言里 struct 承担了更多角色——POD、接口注入、回调封装。命名上推荐：

```c
// struct 名 — PascalCase
// 成员 — snake_case，无后缀
typedef struct {
    float proportional;
    float integral;
    float derivative;
    float output_max;
} PidParams;

// 函数 — 模块前缀_PascalCase
bool Pid_Init(const PidParams *params);
float Pid_Compute(float setpoint, float measured);
```

### C 的枚举和宏

这是 C 和 C++ 分歧最大的地方。C++ 有 `enum class`——类型安全、作用域限定。C 只能裸 `enum`：

```c
// ❌ C enum — 全部漏到全局命名空间
enum { OK, ERROR, TIMEOUT };

// ✅ 加前缀隔离
typedef enum {
    RINGBUF_OK = 0,
    RINGBUF_ERR_NULL = 1,
    RINGBUF_ERR_FULL = 2,
} RingBuf_Error;
```

宏方面，C 没有 `constexpr`，常量只能用 `#define` 或 `const`。规则不变：**宏全大写，const 变量 snake_case**：

```c
#define SENSOR_MAX_CHANNELS 8           // 宏 — 全大写
#define SENSOR_SAMPLE_RATE_HZ 1000      // 宏 — 全大写

static const uint32_t kPollIntervalMs = 100;  // const — k前缀
```

### C 和 C++ 混合项目

如果你的项目是 C HAL 层 + C++ 应用逻辑（FreeRTOS + C++ 很常见）：

- `extern "C"` 包裹所有 C 头文件接口
- C 代码里不要用任何 C++ 特性（`bool` 除外——C23 前用 `<stdbool.h>`，C23 后内置）
- 编译选项里 C 和 C++ 分开设：`-std=c11` + `-std=c++17`

---

## 十三、工具链：别背规范，让机器人干

规范最烦的地方不是"记不住"，而是人工检查浪费时间。三件套搞定：

| 工具 | 作用 | 怎么装 |
|------|------|--------|
| `clang-format` | 自动格式化 | `apt install clang-format` |
| `cpplint` | 风格检查 | `pip install cpplint` |
| `clang-tidy` | 静态分析 + 风格 | `apt install clang-tidy` |

### IDE 集成

VS Code 里，`settings.json` 加：

```json
{
    "C_Cpp.clang_format_style": "Google",
    "editor.formatOnSave": true,
}
```

保存文件时自动格式化。你只管写逻辑，格式交给工具。

### Pre-commit Hook

项目根目录 `.git/hooks/pre-commit`：

```bash
#!/bin/bash
# 保证提交前代码格式不出问题
clang-format --dry-run --Werror $(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(cc|h|cpp|hpp|c)$') \
    || { echo "格式不通过，请运行 clang-format -i 修正"; exit 1; }
```

---

## 十四、完整案例：重构一个 200 行的温控模块

### 重构前（200 行）

```cpp
// tempctl.c — 典型无规范嵌入式文件
#include "main.h"
#include "all_drivers.h"
#include "freertos.h"
#include "utils.h"

int tmp, set, mode, cnt, err;
float kp = 1.5, ki = 0.1, kd = 0.05;
float integ, prev_err;

void init() {
    tmp = 0; set = 250; mode = 1; cnt = 0; err = 0;
    integ = 0; prev_err = 0;
}

void loop() {
    if (mode == 1) {
        tmp = read_adc(3);
        err = set - tmp;
        integ += err * 0.1;
        if (integ > 100) integ = 100;
        if (integ < -100) integ = -100;
        float deriv = (err - prev_err) / 0.1;
        float out = kp * err + ki * integ + kd * deriv;
        if (out > 1000) out = 1000;
        if (out < 0) out = 0;
        set_pwm(1, (int)out);
        prev_err = err;
        cnt++;
    }
}
```

**问题清单**：无类型、无命名、无模块边界、魔法数字、PID 参数全局暴露、无错误处理、ISR 不可重入。

### 重构后

```cpp
// temperature_controller.h
#ifndef TEMPERATURE_CONTROLLER_H_
#define TEMPERATURE_CONTROLLER_H_

#include <cstdint>

namespace temperature_controller {

struct PidParameters {
    float kp;
    float ki;
    float kd;
    float integral_limit;
    float output_max;
    float output_min;
};

class TemperatureController {
 public:
    void Init(const PidParameters &params, uint8_t adc_channel,
              uint8_t pwm_channel);
    void Update();
    bool IsRunning() const { return initialized_; }

 private:
    float ReadTemperature();
    void SetHeaterOutput(float duty_cycle);
    float ComputePid(float setpoint, float measured);

    PidParameters params_;
    uint8_t adc_channel_;
    uint8_t pwm_channel_;
    uint32_t iteration_count_;
    float integral_;
    float prev_error_;
    bool initialized_;
};

}  // namespace temperature_controller

#endif  // TEMPERATURE_CONTROLLER_H_
```

```cpp
// temperature_controller.cc
#include "temperature_controller.h"

#include <algorithm>

#include "adc_driver.h"
#include "logger.h"
#include "pwm_driver.h"

namespace temperature_controller {

static constexpr float kDefaultSetpointCelsius = 250.0f;
static constexpr float kUpdateIntervalSec = 0.1f;

void TemperatureController::Init(const PidParameters &params,
                                  uint8_t adc_channel,
                                  uint8_t pwm_channel) {
    params_ = params;
    adc_channel_ = adc_channel;
    pwm_channel_ = pwm_channel;
    integral_ = 0.0f;
    prev_error_ = 0.0f;
    iteration_count_ = 0;
    initialized_ = true;
    LOG_INFO("TemperatureController initialized on ADC ch=%d, PWM ch=%d",
             adc_channel, pwm_channel);
}

void TemperatureController::Update() {
    if (!initialized_) return;

    const float measured = ReadTemperature();
    const float output = ComputePid(kDefaultSetpointCelsius, measured);
    SetHeaterOutput(output);
    iteration_count_++;
}

float TemperatureController::ReadTemperature() {
    return AdcDriver::ReadVoltage(adc_channel_) * 100.0f;
}

float TemperatureController::ComputePid(float setpoint, float measured) {
    const float error = setpoint - measured;

    integral_ += error * kUpdateIntervalSec;
    integral_ = std::clamp(integral_, -params_.integral_limit,
                           params_.integral_limit);

    const float derivative = (error - prev_error_) / kUpdateIntervalSec;
    prev_error_ = error;

    const float output = params_.kp * error + params_.ki * integral_ +
                         params_.kd * derivative;
    return std::clamp(output, params_.output_min, params_.output_max);
}

void TemperatureController::SetHeaterOutput(float duty_cycle) {
    PwmDriver::SetDuty(pwm_channel_, static_cast<uint32_t>(duty_cycle));
}

}  // namespace temperature_controller
```

同样的 PID 温控逻辑，重构后：
- 命名清楚：`integral_` 替代了 `integ`
- `std::clamp` 替代了手动 `if` 限幅
- `LOG_INFO` 替代了 `printf`
- 命名空间隔离了所有符号
- 类接口明确区分了公有/私有
- `constexpr` 消除了魔法数字 `250`、`0.1`

---

## 十五、最后说两句

规范这东西，争论起来没完没了——缩进用空格还是 Tab、大括号换不换行、变量名用驼峰还是下划线。但写嵌入式的人都知道一个更朴素的事实：**三个月后凌晨两点调 bug 的时候，你不会关心当初写代码时省了 3 秒还是 5 秒。你会关心自己在不在骂那个人。**

Google C++ Style Guide 就是按这个标准设计的。

如果你团队现在就一个人，先做最简单的：命名统一、Include 顺序固定、装个 `clang-format` 保存时自动排版。这三件事没什么认知负担，但效果立竿见影。

如果你在带团队或者维护一个开源项目，再加一条：CI 上挂个 `clang-tidy`，不通过不能合。机器人来当坏人，比人当坏人轻松。

规范是给人看的，不是给编译器看的。编译器不关心你变量叫什么，但人关心。

---

> **参考链接**
>
> - [Google C++ Style Guide 官方](https://google.github.io/styleguide/cppguide.html)
> - [cpplint — Google Style Checker](https://github.com/cpplint/cpplint)
> - [ClangFormat 官方文档](https://clang.llvm.org/docs/ClangFormat.html)
