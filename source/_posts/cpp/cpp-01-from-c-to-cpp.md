---
title: "C++ 学习笔记（一）：从 C 到 C++，你已经会的和需要转变的"
date: 2025-05-02T12:31:22+08:00
categories: ["C/C++"]
tags: ["C++", "C", "嵌入式", "学习笔记"]
cover: /images/cpp_note/cover.png
top_img: false
---

如果你已经用 C 写过嵌入式项目，上手 C++ 的成本比你想象的低——大部分 C 代码可以直接放进 `.cpp` 文件编译通过。真正需要转变的不是语法，而是思维方式：C 是"告诉机器怎么做"，C++ 还多了一层"把相关的数据和操作组织在一起"。

这篇文章不从头教 C++，而是专门讲 C 开发者切换到 C++ 时会碰到的差异点。

---

## 一、引用：比指针少一个 `*`，但不止于此

C 里传指针是家常便饭：

```c
void swap(int *a, int *b) {
    int tmp = *a;
    *a = *b;
    *b = tmp;
}

swap(&x, &y);  // 调用时要取地址
```

C++ 里用引用：

```cpp
void swap(int &a, int &b) {
    int tmp = a;
    a = b;
    b = tmp;
}

swap(x, y);  // 调用时不需要 &，看起来像传值
```

语义上：引用是变量的别名，不是新变量。声明时必须初始化，之后不能改变绑定的对象。

```cpp
int x = 10;
int &ref = x;   // ref 就是 x，不是 x 的拷贝
ref = 20;       // x 现在是 20
```

**和指针的关键区别：**

| | 指针 | 引用 |
|--|------|------|
| 可以为 null | ✅ | ❌ |
| 可以重新绑定 | ✅ | ❌ |
| 需要解引用 `*` | ✅ | ❌ |
| 声明时必须初始化 | ❌ | ✅ |

嵌入式场景里，函数参数用引用的好处：不需要判断空指针（引用天生不为 null），调用点代码更干净。

**const 引用：只读不写**

```cpp
void print_data(const SensorData &data) {
    // data 不能被修改，但没有拷贝开销
}
```

传大结构体首选 `const &`——既避免了拷贝，又明确了函数不修改入参。

---

## 二、函数重载：同一个名字，不同参数

C 里你可能写过：

```c
int    abs_int(int x)    { return x < 0 ? -x : x; }
float  abs_float(float x){ return x < 0.0f ? -x : x; }
```

C++ 允许同名函数：

```cpp
int   abs(int x)   { return x < 0 ? -x : x; }
float abs(float x) { return x < 0.0f ? -x : x; }

abs(-3);    // 调用 int 版本
abs(-3.0f); // 调用 float 版本
```

编译器根据参数类型选择调用哪个，这叫**重载决议**。

注意：返回类型不同不构成重载。下面这个无法编译：

```cpp
int  get_value() { return 1; }
float get_value() { return 1.0f; }  // ❌ 编译错误
```

---

## 三、默认参数

```cpp
void delay(uint32_t ms, bool blocking = true) {
    // ...
}

delay(100);         // blocking = true
delay(100, false);  // blocking = false
```

默认参数必须从右往左连续设置：

```cpp
void func(int a, int b = 10, int c = 20);  // ✅
void func(int a = 1, int b, int c = 20);   // ❌
```

嵌入式里常用于初始化函数：`HAL_UART_Init(&huart1)` 这类 API 如果用 C++ 写，可以把常用参数设默认值，减少重复配置代码。

---

## 四、命名空间：解决名字冲突

C 里经典问题：两个库都定义了 `init()` 函数，链接时冲突。C 的解法是加前缀：`hal_init()`、`rtos_init()`。

C++ 用命名空间：

```cpp
namespace HAL {
    void init() { /* ... */ }
}

namespace RTOS {
    void init() { /* ... */ }
}

HAL::init();   // 明确调用哪个
RTOS::init();
```

`using` 可以省略命名空间前缀：

```cpp
using namespace HAL;
init();  // 等价于 HAL::init()
```

但在嵌入式项目里，**不推荐在头文件里写 `using namespace`**——头文件被多处 include，会把命名空间污染传播出去。在 `.cpp` 文件里局部使用没问题。

---

## 五、`new` 和 `delete`

C 里动态分配：

```c
int *p = (int *)malloc(sizeof(int));
*p = 42;
free(p);
```

C++ 里：

```cpp
int *p = new int(42);   // 分配 + 初始化
delete p;

int *arr = new int[10]; // 数组
delete[] arr;           // 注意：数组用 delete[]
```

`new` 做了两件事：分配内存 + 调用构造函数。`delete` 做了两件事：调用析构函数 + 释放内存。

**嵌入式里的态度：**

裸机 MCU 上谨慎使用 `new/delete`——动态内存的碎片问题和 `malloc/free` 一样存在。更推荐用对象池或栈上对象。但对象的初始化语义（构造函数）仍然值得用，只是分配方式可以是静态的。

```cpp
// 不用 new，但用构造函数语义
static SensorDriver sensor;  // 静态对象，构造函数在程序启动时自动调用
```

---

## 六、`nullptr`，不是 `NULL`

C 里的 `NULL` 本质是 `0` 或 `(void*)0`，有时会让重载产生歧义：

```cpp
void func(int x)  { }
void func(int *p) { }

func(NULL);     // ❌ 歧义：到底是 int(0) 还是 int*(0)？
func(nullptr);  // ✅ 明确是空指针
```

C++ 11 开始用 `nullptr`，类型是 `std::nullptr_t`，不会和整数混淆。规则很简单：**C++ 代码里只用 `nullptr`，不用 `NULL`**。

---

## 七、`//` 注释和 `/* */` 都能用

这个不用解释，C++ 兼容 C 的块注释，同时支持单行 `//`。唯一提一下：C99 之后 C 也支持 `//`，所以这不是 C++ 独有的。

---

## 八、类型转换：用 C++ 风格，别用 C 风格

C 里强制类型转换：

```c
float f = 3.14f;
int i = (int)f;
```

C++ 提供四种具名转换，更安全、更清晰：

```cpp
// static_cast：最常用，编译期检查
int i = static_cast<int>(3.14f);

// reinterpret_cast：底层位模式重新解释，用于硬件寄存器
uint32_t *reg = reinterpret_cast<uint32_t *>(0x40020014);

// const_cast：去除/添加 const（慎用）
const int x = 10;
int *p = const_cast<int *>(&x);

// dynamic_cast：运行时类型检查，嵌入式通常禁用（需要RTTI）
```

嵌入式最常用的两个：`static_cast` 用于普通类型转换，`reinterpret_cast` 用于寄存器地址映射。

C 风格的 `(type)value` 在 C++ 里也能编译，但不推荐——它太宽泛了，会悄悄帮你做 `reinterpret_cast` 级别的危险转换而不报错。

---

## 九、`bool` 是内置类型

C 里没有原生 `bool`（C99 才有 `_Bool`，要 `#include <stdbool.h>`）。C++ 里 `bool` 是内置类型：

```cpp
bool flag = true;
bool done = false;

if (flag) { }         // 不需要写 if (flag == true)
if (!done) { }
```

`true` 转 `int` 是 `1`，`false` 是 `0`。非零整数转 `bool` 是 `true`，`0` 是 `false`。

---

## 十、`inline` 函数替代宏

C 里用宏做简单函数：

```c
#define MAX(a, b) ((a) > (b) ? (a) : (b))
```

宏的问题：没有类型检查、调试困难、`MAX(a++, b++)` 会让 `a` 或 `b` 自增两次。

C++ 里用 `inline` 函数：

```cpp
inline int max(int a, int b) {
    return a > b ? a : b;
}
```

有类型检查，行为可预期，调试器能进入函数体。现代编译器会自动决定是否内联，`inline` 关键字在优化方面的意义已经很小，主要用于解决头文件中函数定义的多重定义问题。

模板函数可以完全替代类型不固定的宏：

```cpp
template<typename T>
inline T max(T a, T b) {
    return a > b ? a : b;
}

max(3, 5);      // int
max(3.0f, 5.0f); // float
```

---

## 十一、`struct` 不用写 typedef

C 里：

```c
typedef struct {
    uint8_t x;
    uint8_t y;
} Point;
```

C++ 里 `struct` 名字直接是类型名：

```cpp
struct Point {
    uint8_t x;
    uint8_t y;
};

Point p;  // 直接用，不需要 typedef
```

C++ 的 `struct` 和 `class` 几乎一样——唯一区别是 `struct` 默认成员是 `public`，`class` 默认是 `private`。

---

## 总结

从 C 切换到 C++，最先感受到的变化：

- 引用让函数接口更干净，不用到处写 `*` 和 `&`
- 函数重载和默认参数减少了 `_int`/`_float` 这类后缀函数
- 命名空间解决了大项目的名字冲突问题
- `nullptr`、具名转换、`bool`、`inline` 是 C++ 提供的更安全的替代品
