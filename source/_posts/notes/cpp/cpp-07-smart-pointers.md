---
title: "C++ 学习笔记（七）：智能指针——unique_ptr 与 shared_ptr"
date: 2025-05-12T22:00:00+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

裸指针本身不表达所有权——看到一个 `int *p`，你不知道它是谁分配的、谁负责释放、释放了没有。智能指针把所有权语义编进类型里，让编译器帮你管理内存。

---

## 一、unique_ptr：独占所有权

`unique_ptr` 表示"这块内存只有我持有，我析构时自动释放"。

```cpp
#include <memory>

std::unique_ptr<uint8_t[]> buf(new uint8_t[256]);
// 或者用 make_unique（C++14）
auto buf = std::make_unique<uint8_t[]>(256);

buf[0] = 0xAB;   // 正常使用，像普通指针一样
// 离开作用域，buf 析构，内存自动释放
```

**独占**的意思是不能拷贝，只能移动：

```cpp
auto a = std::make_unique<int>(42);
auto b = a;            // ❌ 编译错误，不能拷贝
auto b = std::move(a); // ✅ 转移所有权，a 变为 nullptr，b 持有资源
```

转移后 `a` 变为空，不再持有任何资源，析构时什么都不做。

**从函数返回 unique_ptr**

```cpp
std::unique_ptr<SensorDriver> create_sensor(uint8_t addr) {
    return std::make_unique<SensorDriver>(addr);
}

auto sensor = create_sensor(0x48);  // 所有权转移给调用方
```

**传给函数**

```cpp
// 转移所有权：函数接管资源
void take_ownership(std::unique_ptr<SensorDriver> s);

// 只借用，不转移：用裸指针或引用
void borrow(SensorDriver *s);
void borrow(SensorDriver &s);

auto sensor = create_sensor(0x48);
borrow(sensor.get());    // get() 返回裸指针，不转移所有权
borrow(*sensor);         // 解引用，传引用
take_ownership(std::move(sensor));  // 转移，sensor 之后为空
```

**自定义删除器**

`unique_ptr` 可以指定资源释放方式，不只是 `delete`：

```cpp
// 用 free 释放 malloc 分配的内存
std::unique_ptr<uint8_t, decltype(&free)> buf(
    (uint8_t *)malloc(256), free
);

// 用自定义函数关闭硬件
auto cleanup = [](UART_HandleTypeDef *h) { HAL_UART_DeInit(h); };
std::unique_ptr<UART_HandleTypeDef, decltype(cleanup)> uart(&huart1, cleanup);
```

---

## 二、shared_ptr：共享所有权

有时候一块资源需要被多个对象共同持有，最后一个持有者离开时才释放。`shared_ptr` 用引用计数实现这个语义：

```cpp
auto a = std::make_shared<SensorData>();
auto b = a;   // 引用计数 +1，现在是 2
auto c = b;   // 引用计数 +1，现在是 3

// a 析构，引用计数 -1，变为 2，资源不释放
// b 析构，引用计数 -1，变为 1，资源不释放
// c 析构，引用计数 -1，变为 0，资源释放
```

`shared_ptr` 可以拷贝，拷贝时引用计数加一：

```cpp
std::shared_ptr<SensorData> global_data;

void producer(void) {
    auto data = std::make_shared<SensorData>();
    data->value = read_sensor();
    global_data = data;   // 共享给外部
}

void consumer(void) {
    auto local = global_data;  // 拷贝，引用计数 +1
    process(local->value);
}   // local 析构，引用计数 -1
```

**引用计数的开销**

- 每个 `shared_ptr` 对象有两个指针：一个指向资源，一个指向控制块（存放引用计数）
- 引用计数的增减是原子操作，多线程安全，但有 CPU 开销
- 控制块是额外的堆分配，`make_shared` 把资源和控制块合并成一次分配，效率更高

---

## 三、weak_ptr：打破循环引用

`shared_ptr` 互相持有对方时，引用计数永远不归零：

```cpp
struct Node {
    std::shared_ptr<Node> next;
};

auto a = std::make_shared<Node>();
auto b = std::make_shared<Node>();
a->next = b;   // b 的引用计数 = 2（b 自己 + a->next）
b->next = a;   // a 的引用计数 = 2（a 自己 + b->next）
// a、b 离开作用域，引用计数各减 1，变为 1，都不释放，内存泄漏
```

`weak_ptr` 持有弱引用，不增加引用计数：

```cpp
struct Node {
    std::shared_ptr<Node> next;
    std::weak_ptr<Node>   prev;  // 反向引用用 weak_ptr
};
```

使用 `weak_ptr` 时需要先升级为 `shared_ptr`，升级失败说明资源已经释放：

```cpp
std::weak_ptr<SensorData> weak = shared_data;

if (auto p = weak.lock()) {  // 升级成功，p 是 shared_ptr
    process(p->value);
}   // p 析构，引用计数 -1
// 升级失败说明 shared_data 已经释放
```

---

## 四、如何选择

| 场景 | 用哪个 |
|------|--------|
| 独占所有权，单一持有者 | `unique_ptr` |
| 共享所有权，多个持有者 | `shared_ptr` |
| 观察但不持有，避免循环引用 | `weak_ptr` |
| 性能敏感、确定生命周期 | 裸指针（借用语义） |

优先用 `unique_ptr`——它的开销和裸指针完全一样，只是多了析构时的 `delete`，没有任何运行时额外开销。`shared_ptr` 有引用计数的原子操作开销，只在真正需要共享所有权时才用。

---

## 五、嵌入式里的取舍

**Linux 嵌入式**：智能指针开箱即用，和 PC 开发完全一样，`unique_ptr` 几乎可以全面替代 `new/delete`。

**裸机 MCU**：

- 本来就尽量避免动态内存，智能指针用得少
- `unique_ptr` 零开销，在需要动态分配的场合可以用
- `shared_ptr` 的控制块需要额外堆分配，加上原子操作，在没有 OS 的环境里性价比不高
- 如果禁用了 RTTI 和异常（`-fno-rtti -fno-exceptions`），`shared_ptr` 的部分实现可能有问题，取决于工具链

实际上裸机项目里最常见的用法是：对象静态分配，用裸指针传递借用语义，不涉及所有权转移；只在确实需要动态生命周期的地方用 `unique_ptr`。

---

## 总结

- `unique_ptr`：独占所有权，不可拷贝只能移动，零运行时开销，优先使用
- `shared_ptr`：共享所有权，引用计数管理生命周期，有原子操作开销
- `weak_ptr`：弱引用，不增加引用计数，用于打破循环引用或观察资源
- `make_unique` / `make_shared`：比直接 `new` 更安全，`make_shared` 还能减少一次堆分配
- 裸指针不消失：借用语义（不转移所有权）继续用裸指针或引用，清晰且高效
