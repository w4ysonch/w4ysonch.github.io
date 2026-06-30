---
title: "C++ 异常机制：为什么嵌入式不用它，用什么替代"
date: 2026-01-04T08:00:00+08:00
categories: ["C/C++"]
tags: ["C++", "异常", "嵌入式"]
cover: /images/cpp_note/cover.png
top_img: false
---

C++ 异常是标准的错误处理机制，几乎所有 C++ 教材都会讲。但嵌入式项目和 Google 的大型代码库都选择禁掉它——Google C++ Style Guide 明确规定不允许在新代码里使用异常，绝大多数嵌入式工程也用 `-fno-exceptions` 编译。

这篇讲清楚异常是怎么工作的、代价在哪里、以及实际项目里用什么替代。

---

## 一、异常的基本用法

```cpp
#include <stdexcept>

float divide(float a, float b) {
    if (b == 0.0f)
        throw std::invalid_argument("division by zero");
    return a / b;
}

int main() {
    try {
        float r = divide(10.0f, 0.0f);
    } catch (const std::invalid_argument &e) {
        printf("error: %s\n", e.what());
    } catch (...) {
        printf("unknown error\n");
    }
}
```

`throw` 抛出一个异常对象，`catch` 按类型捕获。没有被捕获的异常会一路向上传播，直到调用栈顶，最终触发 `std::terminate()` 终止程序。

标准库的异常层次：

```
std::exception
├── std::logic_error       — 编程错误，理论上可以避免
│   ├── std::invalid_argument
│   ├── std::out_of_range
│   └── std::length_error
└── std::runtime_error     — 运行时才能发现的错误
    ├── std::overflow_error
    └── std::range_error
```

---

## 二、栈展开（Stack Unwinding）

异常的核心机制是**栈展开**。抛出异常后，运行时从当前函数开始，沿调用栈向上搜索匹配的 `catch`，在这个过程中依次析构所有已构造的局部对象。

```cpp
void c() {
    Resource r;   // 构造
    throw std::runtime_error("error");
    // r 的析构函数在展开时被调用
}

void b() {
    Resource r2;  // 构造
    c();          // c 抛出，r2 的析构函数在展开时被调用
}

void a() {
    try {
        b();
    } catch (const std::exception &e) {
        // r 和 r2 已经被析构
        printf("%s\n", e.what());
    }
}
```

栈展开保证了即使出现异常，RAII 对象的析构函数也会被调用——这是异常和资源管理能配合的基础。

---

## 三、为什么有代价

现代编译器实现异常用的是**基于表的方案**：编译器为每个可能经过异常的函数附带一份元数据，记录哪段代码里可能有异常、哪些局部对象需要析构。这些表存在只读数据段里。

好处是正常路径完全不花 CPU——没有额外指令，不抛异常时的开销真的是零。

但代价有两个：

**1. 二进制体积增大**

不只是你写了 `try/catch` 的函数要生成这些表，任何可能被异常穿过的函数都要——整条调用链。即使你的代码没有一行 `throw`，只要链接了一个可能抛异常的库，展开表就得存在。

典型增幅 10%~30%。对于 Flash 只有几百 KB 的 MCU，这个开销很可观。

**2. 抛出时极慢**

一旦真的 `throw`，运行时要查表、遍历调用栈、逐帧析构局部对象。这个过程比普通函数调用慢几个数量级，而且执行时间不确定——对实时系统来说不可接受。

所谓"零开销"只是正常路径，异常路径代价很高。这正好与嵌入式的要求相反——嵌入式要的是二进制小、行为可预期，不关心"极少发生的错误路径快不快"。

---

## 四、`-fno-exceptions` 之后发生什么

加上这个编译选项：

- 编译器不再生成展开表，二进制体积减小
- 代码里写 `throw` 会编译报错（或变成 `std::terminate()`，取决于工具链）
- 标准库里原本抛异常的地方行为改变：
  - `vector::at()` 越界：`abort()` 而不是抛 `std::out_of_range`
  - `new` 失败：返回 `nullptr` 而不是抛 `std::bad_alloc`
  - `dynamic_cast` 失败引用版本：`abort()` 而不是抛 `std::bad_cast`

这意味着你不能靠异常传递错误，必须用其他方式，而且要避免用 `vector::at()` 这类依赖异常语义的接口。

---

## 五、错误码：最直接的替代

返回错误码是 C 的传统做法，也是嵌入式和 Google 代码库里最常见的错误处理方式。

**定义错误类型**

```cpp
enum class Status {
    kOk = 0,
    kTimeout,
    kInvalidArg,
    kBusy,
    kHardwareFault,
};
```

用 `enum class` 而不是裸 `enum` 或 `#define`——有类型检查，不污染全局命名空间，两个模块的错误码不会互相混淆。

**`[[nodiscard]]`：让编译器帮你检查**

错误码最大的问题是调用方容易忽略。C++17 的 `[[nodiscard]]` 让编译器对忽略返回值的地方发出警告：

```cpp
[[nodiscard]] Status uart_send(const uint8_t *data, size_t len);
[[nodiscard]] Status i2c_read(uint8_t addr, uint8_t *buf, size_t len);
```

```cpp
uart_send(buf, len);          // ⚠️ 警告：返回值被丢弃
auto s = uart_send(buf, len); // ✅ 正确处理
if (s != Status::kOk) { ... }
```

**构造函数失败怎么办**

构造函数没有返回值，不能返回错误码。用工厂函数替代：

```cpp
class SensorDriver {
public:
    // 工厂函数，初始化失败返回 nullptr
    static SensorDriver *Create(I2C_HandleTypeDef *i2c, uint8_t addr) {
        auto *s = new SensorDriver(i2c, addr);
        if (!s->Init()) {
            delete s;
            return nullptr;
        }
        return s;
    }

private:
    SensorDriver(I2C_HandleTypeDef *i2c, uint8_t addr);
    bool Init();
};

auto *sensor = SensorDriver::Create(&hi2c1, 0x48);
if (!sensor) {
    // 初始化失败
}
```

裸机上一般不用动态分配，静态分配 + `Init()` 返回 `bool` 更常见：

```cpp
static SensorDriver g_sensor;

if (!g_sensor.Init(&hi2c1, 0x48)) {
    ErrorHandler();
}
```

---

## 六、`std::optional`：有值或没值

C++17 引入，用于函数可能返回有效值、也可能没有值的情况——比异常更轻量，比多出参指针更清晰：

```cpp
#include <optional>

std::optional<float> read_temperature() {
    if (!sensor_ready()) return std::nullopt;
    return sensor_read_float();
}
```

调用方：

```cpp
auto temp = read_temperature();
if (temp) {
    printf("temp: %.2f\n", *temp);
} else {
    // 没有值，处理失败
}

// 或者用 value_or 提供默认值
float t = read_temperature().value_or(25.0f);
```

`std::optional` 没有动态内存分配，对象直接存在 `optional` 内部，栈上分配，零堆开销。`sizeof(optional<float>)` 通常是 `sizeof(float) + 1`（加一个 bool 标志位，再加对齐）。

**适用场景**：查找操作（找到 / 没找到）、可选配置项、可能失败但不需要知道失败原因的场合。

**不适用**：需要区分多种失败原因的场合——`nullopt` 只能表达"没有值"，不能告诉你为什么。

---

## 七、`std::expected`：带错误信息的返回值（C++23）

`std::expected<T, E>` 要么持有成功值 `T`，要么持有错误值 `E`——比返回码更有表达力，比异常更可控：

```cpp
#include <expected>

std::expected<float, Status> read_temperature() {
    if (!i2c_ready()) return std::unexpected(Status::kBusy);
    if (!sensor_present()) return std::unexpected(Status::kHardwareFault);
    return sensor_read_float();
}
```

调用方：

```cpp
auto result = read_temperature();

if (result) {
    printf("temp: %.2f\n", *result);
} else {
    switch (result.error()) {
        case Status::kBusy:        retry_later(); break;
        case Status::kHardwareFault: alert();     break;
        default: break;
    }
}
```

也支持链式操作（`and_then` / `or_else`），避免嵌套 if：

```cpp
auto result = read_raw_adc()
    .and_then(convert_to_voltage)
    .and_then(voltage_to_temperature);
```

`std::expected` 同样无堆分配，成功值和错误值用 union 存储，大小是两者中较大的加上一个标志位。

**C++23 目前支持情况**：GCC 12+、Clang 16+ 原生支持。嵌入式工具链（arm-none-eabi-gcc）从 GCC 12 开始可用，但要确认编译器版本。如果工具链不支持，可以用 [tl::expected](https://github.com/TartanLlama/expected) 这个单头文件库，接口完全兼容 C++23 标准。

---

## 八、断言：处理不该发生的错误

有一类错误不是"需要处理"，而是"根本不应该发生"——函数被传入了 `nullptr`、数组下标越界、状态机进入了不存在的状态。这类用断言，不用错误码：

```cpp
void process_packet(const uint8_t *data, size_t len) {
    assert(data != nullptr);
    assert(len > 0 && len <= MAX_PACKET_SIZE);
    // ...
}
```

Debug 版本（`NDEBUG` 未定义）断言失败时停下来，打印文件名和行号，方便定位问题。Release 版本断言被编译掉，零开销。

嵌入式里通常自定义 `assert`，在失败时做更有用的事——比如把错误记录到 Flash、触发看门狗、或者进入安全模式，而不是简单 `abort()`：

```cpp
#define ASSERT(cond) \
    do { \
        if (!(cond)) { \
            error_log_write(__FILE__, __LINE__, #cond); \
            SystemSafetyShutdown(); \
        } \
    } while (0)
```

断言和错误码的分工：
- **断言**：违反了函数的前置条件，是调用方的 bug，Debug 阶段发现
- **错误码**：运行时环境的问题（硬件故障、超时、资源不足），需要在运行时处理

---

## 九、几种方案的对比

| 方案 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| 错误码 + `[[nodiscard]]` | 所有场合，C++11 起 | 简单直接，零开销，C 互操作好 | 容易被忽略（nodiscard 缓解），不能携带复杂错误信息 |
| `std::optional` | 有值 / 无值，不需要错误原因 | 语义清晰，无堆分配 | 只能表达"没有值"，不能区分失败原因 |
| `std::expected` | 需要区分多种失败原因 | 携带错误信息，可链式操作 | C++23，工具链要求较高 |
| 断言 | 前置条件违反，编程错误 | 零 Release 开销，定位问题快 | 不适合运行时可恢复的错误 |
| 异常 | — | 与 RAII 配合好，标准库原生支持 | 体积增大，实时性不可预期，嵌入式工具链支持不一 |

Google C++ Style Guide 的立场：**禁止异常**，用错误码或 `std::optional`，构造失败用工厂函数。理由是控制流的可预期性比异常的便利性更重要，尤其是在大型代码库里异常的传播路径很难追踪。

---

## 十、`noexcept`：禁异常项目里也有用

即使整个项目禁了异常，`noexcept` 仍然有实际意义。

```cpp
Buffer(Buffer &&other) noexcept;
```

`std::vector` 扩容时，只有移动构造是 `noexcept` 才会选择移动，否则退化为拷贝——这是性能差异，不是功能差异。所以移动构造和移动赋值都应该标 `noexcept`。

另外，析构函数默认隐式 `noexcept`，不需要手动标注，但如果析构里可能 `throw`（几乎不应该发生），要显式声明 `noexcept(false)`。

---

## 总结

- C++ 异常的代价：二进制体积增大 10%~30%，抛出时慢且不确定，不适合嵌入式
- `-fno-exceptions` 禁掉后：`new` 失败返回 `nullptr`，`at()` 越界变 `abort()`，注意这些行为变化
- 替代方案按场景选：
  - 通用错误处理：错误码 + `[[nodiscard]]`
  - 有值/无值：`std::optional`
  - 带错误信息：`std::expected`（C++23）
  - 前置条件检查：断言
- Google Style Guide 和嵌入式工程实践都选择错误码路线，原因是控制流可预期
- `noexcept` 即使在禁异常的项目里也有意义——影响 `std::vector` 扩容时的移动/拷贝选择
