---
title: "C++ 学习笔记（二）：类与对象——构造、析构、访问控制"
date: 2025-05-02T14:23:11+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

C 里你大概写过这种代码：

```c
typedef struct {
    uint8_t  *buf;
    uint32_t  baud;
    uint8_t   initialized;
} UART_Handle;

void UART_Init(UART_Handle *h, uint32_t baud);
void UART_Send(UART_Handle *h, const uint8_t *data, uint16_t len);
void UART_Deinit(UART_Handle *h);
```

数据和操作是分开的——`UART_Handle` 只是一堆字段，函数靠第一个参数 `*h` 关联到数据。这没有任何问题，C 大型项目都是这么做的。

C++ 的类做的事情完全一样，只是把数据和函数打包在一起，编译器帮你传那个隐式的 `*h`：

```cpp
class UartDriver {
public:
    void init(uint32_t baud);
    void send(const uint8_t *data, uint16_t len);
    void deinit();
private:
    uint8_t  *buf_;
    uint32_t  baud_;
    bool      initialized_;
};
```

就这么简单。类不是魔法，是组织代码的方式。

---

## 一、访问控制：public / private / protected

```cpp
class SensorDriver {
public:
    // 外部可以调用
    void init();
    float read();

private:
    // 只有类自己的成员函数能访问
    float calibrate(float raw);
    uint8_t reg_addr_;
    float   offset_;
};
```

- `public`：任何地方都能访问
- `private`：只有本类的成员函数能访问
- `protected`：本类和子类能访问（继承时才有意义，后面讲）

`struct` 和 `class` 唯一的区别：`struct` 默认 `public`，`class` 默认 `private`。

**为什么要 private？**

不是为了藏秘密，是为了划清边界——调用方只能通过 `public` 接口操作对象，内部实现随时可以改，不影响外部代码。`reg_addr_` 是硬件细节，外部不应该直接改它。

---

## 二、构造函数

构造函数在对象创建时自动调用，负责初始化。名字和类名相同，没有返回值：

```cpp
class UartDriver {
public:
    UartDriver(uint32_t baud) {
        baud_        = baud;
        initialized_ = false;
        buf_         = nullptr;
    }

private:
    uint32_t baud_;
    bool     initialized_;
    uint8_t *buf_;
};

// 创建对象时自动调用构造函数
UartDriver uart(115200);  // baud_ = 115200
```

**默认构造函数**

没有参数的构造函数：

```cpp
class GpioPin {
public:
    GpioPin() {
        state_ = false;
    }
private:
    bool state_;
};

GpioPin pin;  // 调用默认构造函数
```

如果你一个构造函数都不写，编译器会生成一个什么都不做的默认构造函数。一旦你写了任何构造函数，编译器就不再自动生成默认构造函数。

**构造函数重载**

```cpp
class Timer {
public:
    Timer() : period_ms_(1000) {}              // 默认 1 秒
    Timer(uint32_t ms) : period_ms_(ms) {}     // 自定义周期

private:
    uint32_t period_ms_;
};

Timer t1;        // period_ms_ = 1000
Timer t2(500);   // period_ms_ = 500
```

---

## 三、初始化列表：比赋值更正确

上面构造函数里写了 `: period_ms_(ms)`，这是**成员初始化列表**，不是在构造函数体内赋值。

```cpp
// 方式 1：初始化列表（推荐）
UartDriver(uint32_t baud) : baud_(baud), initialized_(false), buf_(nullptr) {}

// 方式 2：构造函数体内赋值
UartDriver(uint32_t baud) {
    baud_        = baud;
    initialized_ = false;
    buf_         = nullptr;
}
```

两种方式对 `int`、`bool` 这类基本类型效果一样。但有三种情况**只能用初始化列表**：

**1. `const` 成员**

```cpp
class Config {
public:
    Config(uint32_t id) : id_(id) {}  // ✅
    // Config(uint32_t id) { id_ = id; }  // ❌ const 成员不能赋值
private:
    const uint32_t id_;
};
```

**2. 引用成员**

```cpp
class Logger {
public:
    Logger(UartDriver &uart) : uart_(uart) {}  // ✅ 引用必须在初始化列表绑定
private:
    UartDriver &uart_;
};
```

**3. 没有默认构造函数的成员对象**

```cpp
class System {
public:
    System() : uart_(115200) {}  // ✅ UartDriver 没有默认构造函数，必须在列表里初始化
private:
    UartDriver uart_;
};
```

初始化列表的执行顺序是**成员声明顺序**，不是列表里写的顺序。所以列表的顺序最好和成员声明顺序一致，避免混淆。

---

## 四、析构函数

析构函数在对象销毁时自动调用，负责清理资源：

```cpp
class UartDriver {
public:
    UartDriver(uint32_t baud) : baud_(baud), buf_(nullptr) {
        buf_ = new uint8_t[256];
    }

    ~UartDriver() {          // 析构函数，~ 开头，无参数，无返回值
        delete[] buf_;
        buf_ = nullptr;
    }

private:
    uint32_t baud_;
    uint8_t *buf_;
};
```

对象离开作用域时析构函数自动调用：

```cpp
void task() {
    UartDriver uart(115200);  // 构造：buf_ 分配内存
    uart.send(data, len);
}   // ← uart 离开作用域，析构函数自动调用，buf_ 释放
```

这就是 C++ 里最重要的设计模式 RAII 的基础——资源在构造时获取，在析构时释放，不需要手动管理。RAII 会在后面专门讲。

---

## 五、`this` 指针

每个成员函数都有一个隐式的 `this` 指针，指向当前对象。大部分时候不需要显式写 `this`，但有时候需要：

**1. 成员名和参数名冲突**

```cpp
class GpioPin {
public:
    void set_mode(uint8_t mode) {
        this->mode_ = mode;  // 区分成员 mode_ 和参数 mode
    }
private:
    uint8_t mode_;
};
```

命名规范上用下划线后缀（`mode_`）就能避免这个问题，不需要 `this`。

**2. 返回自身引用（链式调用）**

```cpp
class Builder {
public:
    Builder& set_baud(uint32_t baud) {
        baud_ = baud;
        return *this;  // 返回自身，支持链式调用
    }
    Builder& set_parity(bool parity) {
        parity_ = parity;
        return *this;
    }
private:
    uint32_t baud_;
    bool     parity_;
};

Builder b;
b.set_baud(115200).set_parity(false);  // 链式调用
```

---

## 六、`const` 成员函数

如果一个成员函数不修改对象的状态，应该声明为 `const`：

```cpp
class SensorDriver {
public:
    float read() const {      // 承诺不修改成员变量
        return last_value_;
    }
    void calibrate(float offset) {  // 会修改，不加 const
        offset_ = offset;
    }
private:
    float last_value_;
    float offset_;
};
```

`const` 对象只能调用 `const` 成员函数：

```cpp
const SensorDriver sensor;
sensor.read();       // ✅
sensor.calibrate(1.0f);  // ❌ 编译错误，const 对象不能调用非 const 函数
```

养成习惯：不修改成员的函数一律加 `const`，调用方一眼能看出哪些函数有副作用。

---

## 七、一个完整的嵌入式例子

把上面所有知识点放在一起，写一个简单的 GPIO 驱动类：

```cpp
class GpioPin {
public:
    enum class Mode { Input, Output, Analog };

    // 构造：初始化引脚
    GpioPin(uint32_t pin, Mode mode)
        : pin_(pin), mode_(mode), state_(false) {
        hw_init(pin_, mode_);
    }

    // 析构：复位引脚到默认状态
    ~GpioPin() {
        hw_deinit(pin_);
    }

    // 设置输出（只对 Output 模式有意义）
    void set(bool value) {
        state_ = value;
        hw_write(pin_, value);
    }

    // 读取当前状态
    bool get() const {
        return hw_read(pin_);
    }

    // 翻转
    void toggle() {
        set(!get());
    }

    // 获取引脚编号（只读）
    uint32_t pin() const { return pin_; }

private:
    uint32_t pin_;
    Mode     mode_;
    bool     state_;

    // 底层硬件操作（实际项目里调用 HAL）
    void hw_init(uint32_t pin, Mode mode);
    void hw_deinit(uint32_t pin);
    void hw_write(uint32_t pin, bool value);
    bool hw_read(uint32_t pin) const;
};
```

使用：

```cpp
void blink_task() {
    GpioPin led(GPIO_PIN_13, GpioPin::Mode::Output);  // 构造，自动初始化硬件

    while (true) {
        led.toggle();
        delay_ms(500);
    }
}   // led 离开作用域，析构函数自动调用，引脚复位
```

和 C 版本相比：
- 不需要显式传 `handle`，对象自己携带状态
- 不需要手动调用 `GPIO_Init`/`GPIO_DeInit`，构造析构自动处理
- `Mode` 用枚举类限定了合法值，不会传错参数

---

## 八、对象的生命周期

```cpp
// 栈上对象：离开作用域自动析构
void func() {
    UartDriver uart(115200);  // 构造
    // ...
}  // 析构

// 静态对象：程序启动时构造，程序结束时析构
static UartDriver uart(115200);

// 堆上对象：手动管理（嵌入式里尽量避免）
UartDriver *p = new UartDriver(115200);
delete p;  // 必须手动析构
```

嵌入式裸机里推荐优先用**栈上对象**或**静态对象**，配合 RAII 让编译器管理生命周期，少用 `new/delete`。

---

## 总结

- `public/private`：划清接口和实现的边界
- 构造函数：对象创建时自动初始化
- 初始化列表：比构造函数体内赋值更正确，`const`/引用成员必须用
- 析构函数：对象销毁时自动清理，RAII 的基础
- `const` 成员函数：声明函数不修改对象状态
- `this` 指针：指向当前对象，大多数时候隐式使用
