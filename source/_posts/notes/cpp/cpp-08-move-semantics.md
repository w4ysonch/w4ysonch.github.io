---
title: "C++ 学习笔记（八）：移动语义与右值引用"
date: 2025-05-12T22:00:00+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

拷贝是把资源复制一份，移动是把资源的所有权直接转交出去。对于管理堆内存、文件句柄这类资源的对象，移动比拷贝快得多——拷贝要 `malloc` + `memcpy`，移动只是改几个指针。

---

## 一、左值和右值

理解移动语义之前先搞清楚左值和右值。

**左值（lvalue）**：有名字、有持久地址，可以出现在赋值号左边：

```cpp
int x = 10;       // x 是左值
int arr[4];       // arr[0] 是左值
SensorData data;  // data 是左值
```

**右值（rvalue）**：临时的、没有名字，不能取地址，赋值后就消失：

```cpp
int y = x + 1;    // x + 1 是右值，计算完就没了
func();           // 函数返回的临时对象是右值
42                // 字面量是右值
SensorData()      // 临时构造的对象是右值
```

区分的简单方法：能不能对它取地址。`&x` 合法，`&42` 不合法。

---

## 二、右值引用

C++11 新增了右值引用，用 `&&` 表示，专门用来绑定右值：

```cpp
int &  lref = x;      // 左值引用，绑定左值
int && rref = 42;     // 右值引用，绑定右值
int && rref2 = x;     // ❌ 右值引用不能绑定左值
const int &cref = 42; // ✅ const 左值引用可以绑定右值（老规则）
```

右值引用的意义在于：函数可以通过参数类型区分"调用方是要拷贝"还是"调用方不再需要这个对象了，可以把资源偷走"。

---

## 三、移动构造函数和移动赋值运算符

在 Rule of Three 的基础上，C++11 引入了 **Rule of Five**——管理资源的类通常需要定义五个特殊函数：

1. 析构函数
2. 拷贝构造函数
3. 拷贝赋值运算符
4. **移动构造函数**
5. **移动赋值运算符**

```cpp
class Buffer {
public:
    Buffer(size_t size) : size_(size), ptr_(new uint8_t[size]) {}

    // 拷贝构造：深拷贝，分配新内存
    Buffer(const Buffer &other) : size_(other.size_), ptr_(new uint8_t[other.size_]) {
        memcpy(ptr_, other.ptr_, size_);
    }

    // 移动构造：把 other 的指针偷过来，other 置空
    Buffer(Buffer &&other) noexcept
        : size_(other.size_), ptr_(other.ptr_) {
        other.ptr_  = nullptr;
        other.size_ = 0;
    }

    // 拷贝赋值
    Buffer &operator=(const Buffer &other) {
        if (this == &other) return *this;
        delete[] ptr_;
        size_ = other.size_;
        ptr_  = new uint8_t[size_];
        memcpy(ptr_, other.ptr_, size_);
        return *this;
    }

    // 移动赋值
    Buffer &operator=(Buffer &&other) noexcept {
        if (this == &other) return *this;
        delete[] ptr_;         // 释放自己原有的资源
        ptr_        = other.ptr_;
        size_       = other.size_;
        other.ptr_  = nullptr; // other 置空
        other.size_ = 0;
        return *this;
    }

    ~Buffer() { delete[] ptr_; }

private:
    size_t   size_;
    uint8_t *ptr_;
};
```

移动构造和移动赋值标注 `noexcept` 很重要——STL 容器（如 `std::vector`）在扩容时会判断移动构造是否 `noexcept`，只有 `noexcept` 才会用移动而不是拷贝，否则为了保证异常安全会退化回拷贝。

---

## 四、std::move

`std::move` 不移动任何东西，它只是把左值强制转换为右值引用，告诉编译器"这个对象我不用了，可以移动它"：

```cpp
Buffer a(256);
Buffer b = std::move(a);  // 调用移动构造，a 的资源转移给 b
// a 现在是空的（ptr_ == nullptr），不能再用
```

```cpp
std::vector<Buffer> vec;
Buffer buf(1024);
vec.push_back(std::move(buf));  // 移动进容器，不拷贝
// buf 之后不能再用
```

`std::move` 之后原对象处于"有效但未指定"的状态——可以析构，可以重新赋值，但不能假设它还有什么有意义的内容。

---

## 五、返回值优化（RVO / NRVO）

函数返回局部对象时，编译器通常会做**返回值优化**，直接在调用方的地址上构造对象，完全跳过拷贝和移动：

```cpp
Buffer make_buffer(size_t size) {
    Buffer buf(size);
    // ... 填充数据
    return buf;   // 编译器大概率直接构造在调用方，不发生任何拷贝/移动
}

Buffer b = make_buffer(256);  // 几乎没有额外开销
```

现代编译器（GCC、Clang）对 RVO 的支持非常好，C++17 更是在某些情况下强制要求 RVO。所以从函数返回对象不用担心性能，不需要返回指针或引用来"优化"。

---

## 六、完美转发

模板函数转发参数时，希望保留参数的左值/右值属性，用 `std::forward`：

```cpp
template<typename T>
void wrapper(T &&arg) {
    real_func(std::forward<T>(arg));  // 保留 arg 的左值/右值属性
}
```

这里的 `T &&` 不是右值引用，是**万能引用（forwarding reference）**——当 `T` 被推导时，`T &&` 既可以绑定左值也可以绑定右值，配合 `std::forward` 把属性原样传递下去。

```cpp
int x = 10;
wrapper(x);    // T=int&，arg 是左值引用，forward 保持左值
wrapper(42);   // T=int，arg 是右值引用，forward 保持右值
```

完美转发主要用于实现通用工厂函数、`emplace` 系列接口等。

---

## 七、嵌入式里的实际意义

移动语义在嵌入式里的价值主要体现在两个地方：

**避免不必要的深拷贝**

如果你的类管理了大块 buffer，传递时用移动而不是拷贝，可以省掉 `malloc` + `memcpy` 的开销：

```cpp
// 把采集到的数据包移动进队列，不拷贝
data_queue.push(std::move(packet));
```

**unique_ptr 的所有权转移**

`unique_ptr` 本身就依赖移动语义实现所有权转移，从函数返回 `unique_ptr`、放进容器，都是移动操作：

```cpp
auto sensor = create_sensor(0x48);      // 移动构造
sensors.push_back(std::move(sensor));   // 移动进容器
```

裸机项目里如果没用动态内存，移动语义用得很少。Linux 嵌入式或者用了 STL 容器的项目里，理解移动语义有助于写出性能更好的代码。

---

## 总结

- 左值有名字有地址，右值是临时的没有名字
- 右值引用 `&&`：绑定右值，配合重载区分拷贝和移动语义
- 移动构造/移动赋值：把资源"偷"过来，原对象置空，比深拷贝高效
- `noexcept`：移动操作加上 `noexcept`，STL 容器才会优先选择移动
- `std::move`：把左值转为右值引用，移动后原对象不能再用
- RVO/NRVO：编译器自动优化函数返回值，不需要手动用指针"优化"
- `std::forward`：完美转发，保留参数的左值/右值属性
