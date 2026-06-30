---
title: "C++ 学习笔记（三）：拷贝、赋值与 Rule of Three"
date: 2025-05-03T23:30:00+08:00
categories: ["C/C++"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/cpp_note/cover.png
top_img: false
---

对象被复制的时候发生了什么，是 C++ 里最容易踩坑的问题之一。很多 bug 不是逻辑错误，而是编译器默默帮你生成了一个"看起来能用，实则会崩"的拷贝函数。

---

## 一、默认拷贝：逐字节复制

你没写任何拷贝相关的代码，编译器会生成一个默认拷贝构造函数，做的事是**逐成员复制**：

```cpp
class GpioPin {
public:
    GpioPin(uint32_t pin) : pin_(pin), state_(false) {}
private:
    uint32_t pin_;
    bool     state_;
};

GpioPin a(13);
GpioPin b = a;   // 调用拷贝构造函数，b.pin_ = 13，b.state_ = false
```

对于只含基本类型的类，默认拷贝没问题。

问题出在**含有指针或资源的类**：

```cpp
class UartDriver {
public:
    UartDriver(uint32_t baud) : baud_(baud) {
        buf_ = new uint8_t[256];
    }
    ~UartDriver() {
        delete[] buf_;
    }
private:
    uint32_t baud_;
    uint8_t *buf_;
};

UartDriver a(115200);
UartDriver b = a;   // 默认拷贝：b.buf_ = a.buf_，两者指向同一块内存！
```

现在 `a` 和 `b` 的 `buf_` 指向同一块堆内存。`a` 析构时 `delete[] buf_`，`b` 析构时再 `delete[]` 同一个地址——**double free，程序崩溃**。

---

## 二、拷贝构造函数

拷贝构造函数的签名固定：接受一个 `const` 引用，返回新对象：

```cpp
class UartDriver {
public:
    UartDriver(uint32_t baud) : baud_(baud) {
        buf_ = new uint8_t[256];
    }

    // 拷贝构造函数：深拷贝
    UartDriver(const UartDriver &other) : baud_(other.baud_) {
        buf_ = new uint8_t[256];                    // 分配新内存
        memcpy(buf_, other.buf_, 256);              // 复制内容
    }

    ~UartDriver() {
        delete[] buf_;
    }

private:
    uint32_t baud_;
    uint8_t *buf_;
};

UartDriver a(115200);
UartDriver b = a;   // 调用拷贝构造函数，b 有自己独立的 buf_
```

何时触发拷贝构造函数：

```cpp
UartDriver b = a;        // 拷贝初始化
UartDriver b(a);         // 直接初始化
void func(UartDriver u); // 传值参数
func(a);                 // ← 这里触发拷贝构造
```

---

## 三、拷贝赋值运算符

拷贝构造是"用已有对象初始化新对象"，拷贝赋值是"把已有对象的值赋给另一个已存在的对象"：

```cpp
UartDriver a(115200);
UartDriver b(9600);
b = a;              // 拷贝赋值，不是拷贝构造（b 已经存在）
```

默认赋值运算符同样是逐成员复制，同样有 double free 的问题。需要自己写：

```cpp
class UartDriver {
public:
    // 拷贝赋值运算符
    UartDriver &operator=(const UartDriver &other) {
        if (this == &other) return *this;   // 自赋值检查：a = a

        delete[] buf_;                      // 释放自己原有的资源
        baud_ = other.baud_;
        buf_ = new uint8_t[256];            // 分配新内存
        memcpy(buf_, other.buf_, 256);      // 复制内容

        return *this;                       // 返回自身引用，支持链式赋值 a = b = c
    }

private:
    uint32_t baud_;
    uint8_t *buf_;
};
```

自赋值检查 `if (this == &other)` 很重要——如果没有这行，`a = a` 会先 `delete[] buf_` 再从自己复制，读到已释放的内存。

---

## 四、Rule of Three

这就是著名的 **Rule of Three**：

> 如果你需要自定义以下三者之一，你通常三个都需要自定义：
> 1. 析构函数
> 2. 拷贝构造函数
> 3. 拷贝赋值运算符

道理很简单：需要自定义析构函数，说明类管理了某种资源（动态内存、文件句柄、硬件锁）。既然有资源，拷贝时就需要决定资源怎么处理——深拷贝、禁止拷贝，还是共享所有权。

把三件事放在一起：

```cpp
class UartDriver {
public:
    // 构造
    UartDriver(uint32_t baud) : baud_(baud) {
        buf_ = new uint8_t[256];
    }

    // 1. 拷贝构造
    UartDriver(const UartDriver &other) : baud_(other.baud_) {
        buf_ = new uint8_t[256];
        memcpy(buf_, other.buf_, 256);
    }

    // 2. 拷贝赋值
    UartDriver &operator=(const UartDriver &other) {
        if (this == &other) return *this;
        delete[] buf_;
        baud_ = other.baud_;
        buf_ = new uint8_t[256];
        memcpy(buf_, other.buf_, 256);
        return *this;
    }

    // 3. 析构
    ~UartDriver() {
        delete[] buf_;
    }

private:
    uint32_t baud_;
    uint8_t *buf_;
};
```

---

## 五、禁止拷贝

很多嵌入式驱动类根本不应该被复制——复制一个 UART 驱动意味着什么？两个对象同时操作同一个硬件外设，行为未定义。

正确做法是**明确禁止拷贝**：

```cpp
class UartDriver {
public:
    UartDriver(uint32_t baud);
    ~UartDriver();

    // 禁止拷贝
    UartDriver(const UartDriver &) = delete;
    UartDriver &operator=(const UartDriver &) = delete;

private:
    uint32_t baud_;
    uint8_t *buf_;
};
```

`= delete` 是 C++11 的语法，告诉编译器"这个函数不存在"。试图拷贝这个对象会直接编译报错，比运行时崩溃好得多。

嵌入式里大部分驱动类、单例类都应该 `= delete` 拷贝。

---

## 六、浅拷贝 vs 深拷贝

总结一下两种拷贝的区别：

**浅拷贝（默认行为）**：直接复制指针的值，两个对象共享同一块内存。

```
对象 a: buf_ ──┐
               ├──→ [内存块]
对象 b: buf_ ──┘
```

析构时 double free，或者一个对象修改内容影响另一个。

**深拷贝（自定义拷贝构造）**：分配新内存，复制内容，两个对象完全独立。

```
对象 a: buf_ ──→ [内存块 A]
对象 b: buf_ ──→ [内存块 B]  （内容相同，但独立）
```

选哪种取决于语义：如果拷贝的两个对象应该独立，用深拷贝；如果根本不该被拷贝，用 `= delete`。

---

## 七、嵌入式里的实际建议

动态内存（`new/delete`）在裸机嵌入式里本来就应该少用。Rule of Three 的问题更多出现在 Linux 嵌入式或者用了 STL 的场景。

但理解这个规则很重要，原因有三：

1. 你迟早会写含有指针成员的类
2. 用 STL 容器（`std::vector` 放自定义对象）时，容器会调用拷贝构造
3. Rule of Three 是理解下一步**移动语义**（Rule of Five）的基础

裸机项目里的实用建议：驱动类一律 `= delete` 拷贝，静态分配对象，不用 `new`。

---

## 总结

- 默认拷贝是逐成员复制，含指针的类会导致 double free
- 拷贝构造函数：用已有对象初始化新对象时调用
- 拷贝赋值运算符：给已存在的对象赋值时调用，注意自赋值检查
- Rule of Three：自定义了析构，就要同时考虑拷贝构造和拷贝赋值
- `= delete`：主动禁止拷贝，比让程序运行时崩溃安全得多
