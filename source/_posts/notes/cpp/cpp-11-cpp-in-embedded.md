---
title: "C++ 学习笔记（十一）：C++ 在嵌入式里的取舍"
date: 2025-05-16T17:28:52+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

C++ 的很多特性在桌面和服务器上开销微不足道，但嵌入式的约束不一样——几十 KB 的 Flash、几 KB 的 RAM、没有 MMU、实时性要求。不是所有 C++ 特性都适合拿进来用，也不是所有特性都该排斥。

---

## 一、零开销抽象

C++ 的设计原则之一是"零开销抽象（zero-overhead abstraction）"：你不使用的特性，不产生任何开销；你使用的特性，手写也不会更快。

这个原则在嵌入式里基本成立，但有例外。先看哪些是真的零开销：

**内联函数**

```cpp
inline int clamp(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
```

编译器展开后和宏一样，没有函数调用开销，同时有类型检查。

**模板**

```cpp
template<typename T>
T max(T a, T b) { return a > b ? a : b; }
```

每个实例化是独立的函数，编译器可以充分优化，运行时没有类型分发开销。

**`constexpr`**

```cpp
constexpr uint32_t MHz(uint32_t n) { return n * 1000000u; }
constexpr uint32_t SYSCLK = MHz(168);   // 编译期计算，运行时是常量
```

计算在编译期完成，运行时就是一个立即数。

**RAII / 析构函数**

对于 `LockGuard`、`SpiTransaction` 这类只做简单操作的析构函数，编译器会内联，生成代码和手写 `unlock()`、`cs_high()` 完全一样。

**`std::array`**

固定大小，栈上分配，编译期已知大小，索引访问和裸数组完全一样。

---

## 二、有开销的特性

**虚函数**

虚函数通过 vtable 间接跳转，有两个开销：

1. 每个多态对象多一个 vptr（通常 4 字节），几十个对象就是几百字节
2. 每次虚函数调用一次间接跳转，CPU 无法预测跳转目标，分支预测失效

在 ISR 或高频路径上调用虚函数，timing 会变得不稳定。裸机 MCU 上如果不需要运行时多态，普通函数或模板可以替代。

**动态内存（`new` / `delete`）**

- 堆空间有限，几 KB 到几十 KB
- 反复分配释放会产生碎片，长期运行后可能分配失败
- `malloc` 不是实时安全的，执行时间不确定

**异常**

即使不抛出任何异常，启用异常支持也会增加代码体积（展开表、LSDA 数据），通常增加 10%~30%。大多数嵌入式工程用 `-fno-exceptions` 禁用。

**RTTI（运行时类型信息）**

`dynamic_cast`、`typeid` 需要 RTTI，会在每个多态类上存储类型信息，增加 Flash 占用。通常用 `-fno-rtti` 禁用。

**`std::function`**

类型擦除实现，内部有堆分配（捕获变量超出 SSO 缓冲）和间接调用。高频回调不适合用，函数指针或模板更合适。

**STL 容器（`vector`、`map`、`string`）**

依赖动态内存，在裸机上谨慎使用。

---

## 三、裸机 MCU 的实践原则

**用什么**

- `constexpr`：替代 `#define` 常量和宏计算，有类型检查，编译期求值
- `inline` 函数：替代函数宏，类型安全
- 模板：替代重复的类型相关代码，零运行时开销
- 引用：替代指针传参，语义更清晰
- `std::array`：替代裸数组，有边界信息和迭代器
- RAII：管理锁、片选、关中断，代码更安全
- `enum class`：替代 `#define` 枚举，有类型检查，不污染全局命名空间
- `nullptr`：替代 `NULL`，类型安全
- `auto`：减少重复类型名，增加可读性
- `unique_ptr`：在需要动态分配的地方替代裸 `new/delete`

**不用或谨慎用什么**

- 异常：用 `-fno-exceptions`，错误通过返回值或错误码传递
- RTTI：用 `-fno-rtti`，不用 `dynamic_cast` 和 `typeid`
- 虚函数：实时路径上避免，非时间敏感的初始化/配置逻辑可以用
- 动态内存：尽量静态分配，实在需要就在启动时一次性分配，不要在运行时反复 `new/delete`
- `std::function`：高频回调不用，低频的配置类回调可以接受

---

## 四、Linux 嵌入式的实践原则

有 MMU、有完整的 OS、有充裕的内存，限制少得多：

**基本没有顾虑的**：所有 C++11/14/17 特性，STL 容器，智能指针，`std::function`，RTTI。

**仍然需要注意的**：

- 实时进程（`SCHED_FIFO`）里避免动态内存，`malloc` 可能触发缺页中断，破坏实时性
- 虚函数在热路径上仍然有 cache miss 风险，量大时考虑用模板或函数指针
- 异常可以用，但嵌入式 Linux 项目里通常也会限制异常的使用范围，错误处理混用两套风格会让代码难以维护

---

## 五、编译器选项

嵌入式项目常见的 C++ 编译选项组合：

```cmake
# 裸机 MCU 典型配置
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}
    -fno-exceptions
    -fno-rtti
    -fno-threadsafe-statics
    -ffunction-sections
    -fdata-sections
")
# 链接时去掉未用到的函数和数据
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,--gc-sections")
```

- `-fno-exceptions`：禁用异常，减少代码体积
- `-fno-rtti`：禁用运行时类型信息
- `-fno-threadsafe-statics`：局部静态变量的线程安全初始化需要加锁，裸机不需要，禁掉省代码
- `-ffunction-sections` / `-fdata-sections` + `--gc-sections`：把每个函数/变量放进独立的 section，链接时删掉没用到的，减少最终二进制体积

---

## 六、和 C 混用

嵌入式项目里 C 和 C++ 经常共存——HAL 库是 C 写的，上层应用想用 C++。

```cpp
// 在 C++ 文件里调用 C 函数
extern "C" {
#include "stm32f4xx_hal.h"
#include "freertos/FreeRTOS.h"
}
```

`extern "C"` 告诉编译器这些函数用 C 的链接约定（不做名字改写），链接时才能找到正确的符号。

FreeRTOS 任务函数必须是 C 函数指针签名，可以用无捕获 Lambda 或静态成员函数适配：

```cpp
class SensorTask {
public:
    static void task_entry(void *param) {
        auto *self = static_cast<SensorTask *>(param);
        self->run();
    }
    void run() { /* 任务主循环 */ }
};

SensorTask task;
xTaskCreate(SensorTask::task_entry, "sensor", 256, &task, 2, nullptr);
```

---

## 总结

- 零开销特性放心用：`constexpr`、模板、`inline`、`std::array`、RAII、引用、`enum class`
- 有开销特性按场景用：虚函数（非实时路径可以）、`unique_ptr`（需要动态分配时）
- 裸机上禁掉：异常、RTTI、运行时动态内存（能静态就静态）
- Linux 嵌入式限制少，但实时进程里仍然要避免动态分配
- C 和 C++ 混用靠 `extern "C"`，任务入口用静态成员函数适配 C 函数指针
