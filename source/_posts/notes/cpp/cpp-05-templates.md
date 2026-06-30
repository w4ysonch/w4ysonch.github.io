---
title: "C++ 学习笔记（五）：模板基础——函数模板与类模板"
date: 2025-05-04T15:55:21+08:00
categories: ["笔记"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/notes/cpp_note/cover.png
top_img: false
---

模板是 C++ 的编译期多态机制。写一份代码，编译器根据实际使用的类型自动生成对应版本，运行时没有额外开销。

---

## 一、函数模板

写一个交换两个变量的函数，C 里要为每种类型单独写一个：

```c
void swap_int(int *a, int *b)     { int t = *a; *a = *b; *b = t; }
void swap_float(float *a, float *b) { float t = *a; *a = *b; *b = t; }
```

C++ 里用函数模板：

```cpp
template<typename T>
void swap(T &a, T &b) {
    T tmp = a;
    a = b;
    b = tmp;
}

int   x = 1, y = 2;
float p = 1.0f, q = 2.0f;

swap(x, y);    // 编译器生成 swap<int>
swap(p, q);    // 编译器生成 swap<float>
```

`typename T` 是类型参数，可以写成 `class T`，含义相同，`typename` 更直观。

**显式指定类型**

大多数情况下编译器能推导出 `T`，但也可以手动指定：

```cpp
swap<int>(x, y);      // 显式指定为 int
swap<double>(x, y);   // 强制用 double，x 和 y 会被转换
```

**多个类型参数**

```cpp
template<typename T, typename U>
void print_pair(T a, U b) {
    printf("(%d, %f)\n", a, b);  // 这里只是示意
}

print_pair(1, 3.14f);   // T=int, U=float
```

---

## 二、类模板

函数模板解决单个函数的复用，类模板解决整个数据结构的复用。

一个固定容量的环形缓冲区，嵌入式里非常常用：

```cpp
template<typename T, size_t N>
class RingBuffer {
public:
    RingBuffer() : head_(0), tail_(0), count_(0) {}

    bool push(const T &val) {
        if (count_ == N) return false;   // 满了
        buf_[tail_] = val;
        tail_ = (tail_ + 1) % N;
        ++count_;
        return true;
    }

    bool pop(T &val) {
        if (count_ == 0) return false;   // 空了
        val = buf_[head_];
        head_ = (head_ + 1) % N;
        --count_;
        return true;
    }

    bool empty() const { return count_ == 0; }
    bool full()  const { return count_ == N; }
    size_t size() const { return count_; }

private:
    T      buf_[N];
    size_t head_, tail_, count_;
};
```

使用：

```cpp
RingBuffer<uint8_t, 64>  uart_rx;   // 存 uint8_t，容量 64
RingBuffer<SensorData, 8> samples;  // 存自定义结构体，容量 8

uint8_t byte;
uart_rx.push(0xAB);
uart_rx.pop(byte);
```

`N` 是非类型模板参数，编译期确定大小，`buf_` 直接在对象内部，不需要动态分配——这是嵌入式里用类模板的最大好处。

---

## 三、模板特化

有时候某个特定类型需要不同的实现，可以针对这个类型写特化版本。

```cpp
// 通用版本
template<typename T>
T abs_val(T x) {
    return x < T(0) ? -x : x;
}

// 针对 float 的特化——用硬件 fabs 指令
template<>
float abs_val<float>(float x) {
    return __builtin_fabsf(x);
}
```

调用时编译器会优先选择特化版本：

```cpp
abs_val(-3);      // 用通用版本，T=int
abs_val(-3.0f);   // 用特化版本，直接 fabsf
```

**偏特化**

类模板还支持偏特化——只固定部分类型参数：

```cpp
// 通用版本
template<typename T, size_t N>
class RingBuffer { /* ... */ };

// 偏特化：T 是指针类型时的版本
template<typename T, size_t N>
class RingBuffer<T*, N> {
    // 指针类型的特殊处理
};
```

函数模板不支持偏特化，只能用重载代替。

---

## 四、模板的编译期计算

模板不只能参数化类型，也能做编译期计算：

```cpp
// 编译期计算 2 的 N 次方
template<int N>
struct PowerOf2 {
    static const int value = 2 * PowerOf2<N-1>::value;
};

template<>
struct PowerOf2<0> {
    static const int value = 1;
};

int buf[PowerOf2<10>::value];  // buf[1024]，编译期确定大小
```

这种技术叫**模板元编程**，可以把部分计算从运行时移到编译期，嵌入式里用来生成查找表、CRC 表、三角函数表：

```cpp
// 编译期生成 CRC32 查找表（实际项目里的用法）
template<uint32_t C, int K = 8>
struct CrcEntry {
    static const uint32_t value =
        CrcEntry<(C & 1) ? (0xEDB88320u ^ (C >> 1)) : (C >> 1), K-1>::value;
};

template<uint32_t C>
struct CrcEntry<C, 0> {
    static const uint32_t value = C;
};
```

---

## 五、typename 和 class 的区别

在模板参数里两者完全等价：

```cpp
template<typename T> void func(T x);
template<class T>    void func(T x);  // 一样
```

但在模板内部访问嵌套类型时，必须用 `typename` 消歧义：

```cpp
template<typename T>
void func() {
    typename T::iterator it;  // 告诉编译器 T::iterator 是一个类型，不是静态成员
}
```

这是编译器的限制：它不知道 `T::iterator` 是类型还是变量，`typename` 明确告诉它是类型。

---

## 六、模板在嵌入式里的取舍

模板的好处很明显：零运行时开销，类型安全，代码复用。但也有代价：

**代码膨胀**：每种类型实例化一份代码。`RingBuffer<uint8_t, 64>` 和 `RingBuffer<uint16_t, 64>` 是完全独立的两份代码，Flash 占用翻倍。

**编译时间增长**：模板在头文件里展开，每个包含头文件的编译单元都要处理。

**调试困难**：模板报错信息出了名的难看。

实际使用建议：

- 数据结构类（环形缓冲区、队列、栈）非常适合模板——同一份代码服务不同类型，比虚函数版本少一个指针开销
- 驱动抽象层酌情使用，如果类型组合不多，直接写具体类更清晰
- 避免为了"通用"而过度模板化——三个用到的类型，写三个具体类反而更好维护

---

## 总结

- 函数模板：同一逻辑适配不同类型，编译器自动推导，也可以显式指定
- 类模板：参数化整个数据结构，非类型参数（如 `size_t N`）可以编译期确定大小
- 模板特化：针对特定类型提供定制实现
- 模板元编程：把计算从运行时移到编译期
- 代价：代码膨胀、编译时间、报错难读——按需使用，不要过度设计
