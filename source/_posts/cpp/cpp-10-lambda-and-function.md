---
title: "C++ 学习笔记（十）：Lambda 与 std::function"
date: 2025-05-15T18:21:33+08:00
categories: ["C/C++"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/cpp_note/cover.png
top_img: false
---

C 里把函数当参数传递要用函数指针，写起来繁琐，而且无法捕获上下文。Lambda 是 C++11 引入的匿名函数，可以在需要的地方直接定义，还能捕获周围的变量。

---

## 一、Lambda 基本语法

```cpp
[捕获列表](参数列表) -> 返回类型 { 函数体 }
```

返回类型可以省略，编译器自动推导：

```cpp
auto add = [](int a, int b) { return a + b; };
int result = add(3, 4);   // 7
```

没有参数时括号可以省略：

```cpp
auto greet = [] { printf("hello\n"); };
greet();
```

---

## 二、捕获列表

Lambda 可以捕获外部作用域的变量，这是函数指针做不到的：

```cpp
int threshold = 30;

auto is_hot = [threshold](float temp) {
    return temp > threshold;   // 使用了外部变量 threshold
};

is_hot(35.0f);  // true
```

捕获方式：

```cpp
int x = 10, y = 20;

[x]       // 按值捕获 x
[&x]      // 按引用捕获 x
[=]       // 按值捕获所有用到的外部变量
[&]       // 按引用捕获所有用到的外部变量
[=, &x]   // 默认按值，x 按引用
[&, x]    // 默认按引用，x 按值
[this]    // 捕获当前对象的 this 指针（成员函数里用）
```

**按值捕获**：Lambda 内有一份独立的拷贝，外部变量改变不影响 Lambda 内部：

```cpp
int count = 0;
auto inc = [count]() mutable {  // mutable 允许修改按值捕获的副本
    count++;
    return count;
};
inc();   // 返回 1，但外部 count 还是 0
```

**按引用捕获**：Lambda 内直接操作外部变量，注意生命周期——Lambda 的生命周期不能超过被引用变量：

```cpp
int count = 0;
auto inc = [&count] { count++; };
inc();   // 外部 count 变为 1
inc();   // 外部 count 变为 2
```

---

## 三、Lambda 的类型和 auto

每个 Lambda 的类型都是唯一的匿名类型，只能用 `auto` 接收：

```cpp
auto f = [](int x) { return x * 2; };
```

如果需要存储或传递 Lambda，用 `std::function`（后面讲）或模板。

**Lambda 作为参数**

STL 算法大量使用 Lambda：

```cpp
#include <algorithm>
#include <vector>

std::vector<int> v = {3, 1, 4, 1, 5, 9, 2, 6};

// 排序
std::sort(v.begin(), v.end(), [](int a, int b) { return a < b; });

// 查找第一个大于 4 的元素
auto it = std::find_if(v.begin(), v.end(), [](int x) { return x > 4; });

// 过滤：移除所有奇数
v.erase(
    std::remove_if(v.begin(), v.end(), [](int x) { return x % 2 != 0; }),
    v.end()
);

// 遍历
std::for_each(v.begin(), v.end(), [](int x) { printf("%d ", x); });
```

---

## 四、std::function

`std::function` 是一个通用的可调用对象包装器，可以存储函数指针、Lambda、仿函数：

```cpp
#include <functional>

std::function<int(int, int)> op;  // 签名：接受两个 int，返回 int

op = [](int a, int b) { return a + b; };
op(3, 4);   // 7

op = [](int a, int b) { return a * b; };
op(3, 4);   // 12
```

**存储不同类型的可调用对象**

```cpp
int add(int a, int b) { return a + b; }

std::function<int(int, int)> f;

f = add;                              // 普通函数
f = [](int a, int b){ return a-b; }; // Lambda
f = std::plus<int>();                 // 标准库仿函数
```

**用于回调**

```cpp
class Button {
public:
    void set_callback(std::function<void()> cb) {
        callback_ = cb;
    }
    void press() {
        if (callback_) callback_();
    }
private:
    std::function<void()> callback_;
};

Button btn;
int click_count = 0;
btn.set_callback([&click_count] {
    click_count++;
    printf("clicked %d times\n", click_count);
});
btn.press();
btn.press();
```

---

## 五、std::function 的开销

`std::function` 使用了类型擦除（type erasure），内部通过虚函数调用实现，有以下开销：

- **堆分配**：捕获了变量的 Lambda 如果超出内部缓冲大小，会触发堆分配
- **间接调用**：每次调用有一次虚函数跳转，无法内联
- **空检查**：调用前需要检查是否为空

对比裸函数指针和模板，`std::function` 灵活但有代价。性能敏感的路径，优先用函数指针或模板。

```cpp
// 函数指针：零开销，但不能捕获上下文
void (*fp)(int) = [](int x) { printf("%d\n", x); };  // 无捕获 Lambda 可以转函数指针

// 模板：编译期解析，可以内联，但不能运行时切换
template<typename F>
void call(F &&f, int x) { f(x); }
```

---

## 六、std::bind

`std::bind` 可以绑定函数的部分参数，生成一个新的可调用对象：

```cpp
#include <functional>

int add(int a, int b) { return a + b; }

auto add5 = std::bind(add, 5, std::placeholders::_1);
add5(3);   // 8，相当于 add(5, 3)
add5(10);  // 15
```

现代 C++ 里 Lambda 基本可以替代 `std::bind`，而且更直观：

```cpp
auto add5 = [](int b) { return add(5, b); };
```

`std::bind` 语法繁琐，类型推导复杂，错误信息难看，除非维护老代码，否则直接用 Lambda。

---

## 七、嵌入式里的使用场景

**回调和事件驱动**

嵌入式里按键、定时器、通信协议解析都需要回调。用 Lambda 可以直接在注册处写逻辑，不需要把回调写成单独的全局函数：

```cpp
timer.set_callback([&led] {
    led.toggle();
});

uart.on_receive([&parser](uint8_t byte) {
    parser.feed(byte);
});
```

**状态机**

Lambda 可以作为状态的动作函数，让状态机的代码更集中：

```cpp
std::array<std::function<void()>, 4> state_actions = {
    [] { enter_idle(); },
    [] { start_measure(); },
    [] { process_data(); },
    [] { report_result(); },
};

state_actions[current_state]();
```

**注意事项**

- 裸机上避免用捕获了大量变量的 Lambda 赋给 `std::function`，可能触发堆分配
- 无捕获的 Lambda 可以直接转为函数指针，没有任何开销，适合 C 风格的回调接口（如 FreeRTOS 任务函数）
- 捕获 `this` 时注意对象生命周期，Lambda 的生命周期不能超过对象

---

## 总结

- Lambda：匿名函数，可以捕获上下文，适合作为 STL 算法的谓词和回调
- 捕获方式：`[=]` 按值，`[&]` 按引用，混合捕获可以精确控制
- `std::function`：通用可调用对象包装器，灵活但有类型擦除开销
- 无捕获 Lambda 可以转为裸函数指针，零开销
- `std::bind` 基本被 Lambda 取代，现代 C++ 里少用
