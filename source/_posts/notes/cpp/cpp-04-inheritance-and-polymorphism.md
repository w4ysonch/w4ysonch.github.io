---
title: "C++ 学习笔记（四）：继承与多态——虚函数和 vtable 的代价"
date: 2025-05-04T15:21:32+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

项目里加了第二种传感器，轮询函数就要改一次；加了第三种，再改一次。继承和多态解决的就是这个问题——不同类型的对象，对外暴露同一套接口，上层代码不需要知道底下是什么。

---

## 一、继承：复用已有的类

假设你有一个传感器基类：

```cpp
class Sensor {
public:
    Sensor(uint8_t addr) : addr_(addr) {}

    void set_address(uint8_t addr) { addr_ = addr; }
    uint8_t address() const { return addr_; }

protected:
    uint8_t addr_;
};
```

温度传感器和湿度传感器都有地址，都需要 `set_address`，没必要重复写。用继承：

```cpp
class TempSensor : public Sensor {
public:
    TempSensor(uint8_t addr) : Sensor(addr) {}  // 调用基类构造函数

    float read_temp() {
        // 读温度的实现
        return raw_to_celsius(read_reg(addr_));  // 可以访问 protected 成员
    }

private:
    float raw_to_celsius(uint8_t raw);
    uint8_t read_reg(uint8_t addr);
};

class HumiSensor : public Sensor {
public:
    HumiSensor(uint8_t addr) : Sensor(addr) {}

    float read_humidity();
};
```

`TempSensor` 自动拥有 `set_address` 和 `address()`，不需要重新写。

**继承方式**

```cpp
class Child : public Base    // 最常用：public 成员保持 public
class Child : protected Base // public 成员变 protected
class Child : private Base   // public 成员变 private
```

绝大多数情况用 `public` 继承。`protected`/`private` 继承有特殊用途，不常见。

---

## 二、多态：同一接口，不同行为

继承解决了代码复用，多态解决了另一个问题：用统一的方式操作不同类型的对象。

先看没有多态时的问题：

```cpp
void read_sensor(TempSensor *s)  { s->read_temp(); }
void read_sensor(HumiSensor *s)  { s->read_humidity(); }
// 每加一种传感器就要加一个重载……
```

用多态，定义一个统一的接口：

```cpp
class Sensor {
public:
    Sensor(uint8_t addr) : addr_(addr) {}
    virtual float read() = 0;  // 纯虚函数，子类必须实现
    virtual ~Sensor() {}       // 虚析构函数，后面解释为什么需要

protected:
    uint8_t addr_;
};

class TempSensor : public Sensor {
public:
    TempSensor(uint8_t addr) : Sensor(addr) {}
    float read() override { return raw_to_celsius(read_reg(addr_)); }
private:
    float raw_to_celsius(uint8_t raw);
    uint8_t read_reg(uint8_t addr);
};

class HumiSensor : public Sensor {
public:
    HumiSensor(uint8_t addr) : Sensor(addr) {}
    float read() override { return read_reg(addr_) / 2.55f; }
private:
    uint8_t read_reg(uint8_t addr);
};
```

现在可以统一操作：

```cpp
void poll(Sensor *s) {
    float val = s->read();  // 运行时决定调用哪个 read()
    log(val);
}

TempSensor temp(0x48);
HumiSensor humi(0x40);

poll(&temp);  // 调用 TempSensor::read()
poll(&humi);  // 调用 HumiSensor::read()
```

---

## 三、virtual、override、纯虚函数

**`virtual`**：告诉编译器这个函数可以被子类覆盖，调用时根据对象的实际类型决定调用哪个版本。

**`override`**：C++11 新增，声明这个函数是覆盖基类的虚函数。可以不写，但强烈建议写——编译器会检查基类里是否真的有这个虚函数，防止函数签名写错时默默创建了一个新函数：

```cpp
class Base {
    virtual void func(int x);
};

class Child : public Base {
    void func(int x) override;   // ✅ 编译器确认 Base 有 func(int)
    void func(float x) override; // ❌ 编译错误，Base 没有 func(float)
    void func(float x);          // 😶 没有报错，但这是新函数，不是覆盖
};
```

**纯虚函数 `= 0`**：声明基类不提供实现，子类必须实现。含有纯虚函数的类是**抽象类**，不能直接实例化：

```cpp
Sensor s(0x48);   // ❌ 编译错误，Sensor 是抽象类
Sensor *p = new TempSensor(0x48);  // ✅ 指针可以指向子类对象
```

---

## 四、虚析构函数

这是一个经典陷阱：

```cpp
class Sensor {
public:
    ~Sensor() { /* 清理基类资源 */ }  // 没有 virtual
};

class TempSensor : public Sensor {
public:
    TempSensor() { buf_ = new uint8_t[64]; }
    ~TempSensor() { delete[] buf_; }   // 释放子类资源
private:
    uint8_t *buf_;
};

Sensor *p = new TempSensor();
delete p;  // 只调用 ~Sensor()，~TempSensor() 没有被调用！buf_ 泄漏！
```

`delete` 通过基类指针删除对象时，如果析构函数不是虚函数，只会调用基类析构，子类的析构函数被跳过，资源泄漏。

解决：**基类析构函数加 `virtual`**：

```cpp
class Sensor {
public:
    virtual ~Sensor() {}  // 虚析构
};
```

规则：**只要类有虚函数，析构函数就应该是虚的。**

---

## 五、vtable：多态的代价

虚函数是怎么实现的？编译器为每个含有虚函数的类生成一张**虚函数表（vtable）**，每个对象里有一个指向该表的指针（vptr）。

```
TempSensor 对象在内存里：
┌──────────────┐
│   vptr       │──→ TempSensor::vtable
├──────────────┤        ┌─────────────────────┐
│   addr_      │        │ TempSensor::read()  │
├──────────────┤        │ TempSensor::~Temp.. │
│   ...        │        └─────────────────────┘
└──────────────┘
```

调用 `s->read()` 时，实际执行的是：
1. 通过 `vptr` 找到 vtable
2. 在 vtable 里找到 `read` 的地址
3. 跳转执行

**代价：**

- **每个对象多一个 `vptr`**：4 字节（32位）或 8 字节（64位）。1000 个对象就是 4KB 额外开销
- **间接调用，无法内联**：普通函数调用可以被编译器内联优化，虚函数调用必须查表，多一次内存访问
- **icache 压力**：间接跳转对 CPU 分支预测不友好

在 PC 上这些开销可以忽略。在 Cortex-M 上，内存本来就几十 KB，高频调用的函数能否内联直接影响性能。

---

## 六、嵌入式里的权衡

**适合用虚函数的场景：**

- 设备驱动抽象层：`UartBase`、`SpiBase`，不同硬件平台实现不同，调用频率低
- 状态机：每个状态是一个对象，`handle_event()` 是虚函数
- 初始化阶段的策略选择

**不适合用虚函数的场景：**

- 高频中断处理函数（每微秒调用一次的代码）
- 内存极度紧张的场合（每个对象 4 字节 vptr 都很贵）
- 实时性要求严格的控制循环

**替代方案：函数指针 / 模板**

如果需要多态但不想要 vtable 开销，C++ 有两种方法：

```cpp
// 方案一：函数指针（和 C 一样，零开销）
struct SensorOps {
    float (*read)(void *ctx);
};

// 方案二：模板（编译期多态，零运行时开销）
template<typename T>
void poll(T &sensor) {
    float val = sensor.read();  // 编译期确定调用哪个 read，可以内联
}
```

模板是嵌入式里替代虚函数的常用手段，代价是编译时间变长、代码体积可能增大（每种类型生成一份代码）。

---

## 七、完整例子：传感器抽象层

```cpp
// 抽象基类
class ISensor {
public:
    virtual ~ISensor() {}
    virtual bool init() = 0;
    virtual float read() = 0;
    virtual const char *name() const = 0;
};

// STM32 上的 I2C 温度传感器
class Stm32TempSensor : public ISensor {
public:
    Stm32TempSensor(I2C_HandleTypeDef *hi2c, uint8_t addr)
        : hi2c_(hi2c), addr_(addr) {}

    bool init() override {
        return HAL_I2C_IsDeviceReady(hi2c_, addr_, 3, 100) == HAL_OK;
    }

    float read() override {
        uint8_t data[2];
        HAL_I2C_Master_Receive(hi2c_, addr_, data, 2, 100);
        return ((data[0] << 8 | data[1]) >> 4) * 0.0625f;
    }

    const char *name() const override { return "TMP102"; }

private:
    I2C_HandleTypeDef *hi2c_;
    uint8_t addr_;
};

// 上层代码只依赖接口，不关心具体实现
void log_all(ISensor **sensors, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        printf("%s: %.2f\n", sensors[i]->name(), sensors[i]->read());
    }
}
```

换平台时只需要换 `Stm32TempSensor` 的实现，`log_all` 和所有上层代码一行不用改。

---

## 总结

- 继承：子类自动拥有基类的成员和方法，用 `public` 继承
- `virtual`：运行时根据对象实际类型调用对应函数
- `override`：明确标记覆盖，让编译器帮你检查签名
- 纯虚函数 `= 0`：定义接口，强制子类实现
- 虚析构函数：只要类有虚函数，析构就要加 `virtual`
- vtable 的代价：每个对象多一个指针，调用多一次间接跳转，无法内联
- 嵌入式里：低频的抽象层用虚函数没问题，高频路径考虑模板或函数指针
