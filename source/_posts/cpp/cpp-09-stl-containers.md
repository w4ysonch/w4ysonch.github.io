---
title: "C++ 学习笔记（九）：STL 容器实战——vector、map、string"
date: 2025-05-14T21:00:00+08:00
categories: ["C/C++"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/cpp_note/cover.png
top_img: false
---

STL 容器是 C++ 标准库里最常用的部分。不同容器背后是不同的数据结构，选错了轻则性能差，重则在嵌入式上把内存吃光。这篇重点讲三个最常用的：`vector`、`map`、`string`，以及在嵌入式里该怎么用。

---

## 一、vector：动态数组

`vector` 是最常用的容器，本质是一块连续内存的动态数组，支持随机访问，尾部插入摊销 O(1)。

```cpp
#include <vector>

std::vector<int> v;
v.push_back(1);
v.push_back(2);
v.push_back(3);

// 访问元素
v[0];          // 不检查越界
v.at(0);       // 检查越界，越界抛 std::out_of_range
v.front();     // 第一个元素
v.back();      // 最后一个元素

// 大小
v.size();      // 元素个数
v.capacity();  // 当前分配的容量
v.empty();     // 是否为空

// 删除
v.pop_back();              // 删除最后一个
v.erase(v.begin() + 1);   // 删除第二个元素，O(n)
v.clear();                 // 清空，不释放内存
```

**扩容机制**

`vector` 容量不够时自动扩容，通常是翻倍。扩容时分配新内存、移动所有元素、释放旧内存。这意味着：

- 扩容时所有迭代器和指针失效
- 频繁 `push_back` 如果触发多次扩容，会有内存碎片和拷贝开销

知道大小时提前 `reserve`：

```cpp
std::vector<SensorData> samples;
samples.reserve(100);   // 预分配 100 个元素的空间，不触发扩容
for (int i = 0; i < 100; ++i)
    samples.push_back(read_sensor());
```

**初始化方式**

```cpp
std::vector<int> a(10);          // 10 个元素，值初始化为 0
std::vector<int> b(10, 255);     // 10 个元素，全部为 255
std::vector<int> c = {1, 2, 3};  // 初始化列表
std::vector<int> d(c);           // 拷贝构造
```

**遍历**

```cpp
// 范围 for（推荐）
for (const auto &item : v) {
    process(item);
}

// 索引
for (size_t i = 0; i < v.size(); ++i) {
    process(v[i]);
}

// 迭代器
for (auto it = v.begin(); it != v.end(); ++it) {
    process(*it);
}
```

**emplace_back vs push_back**

`push_back` 先构造临时对象再拷贝/移动进容器，`emplace_back` 直接在容器内部原地构造，少一次构造：

```cpp
struct Point { int x, y; };

v.push_back(Point{1, 2});    // 构造临时 Point，再移动进去
v.emplace_back(1, 2);        // 直接在 vector 内部构造，参数转发给构造函数
```

---

## 二、map 和 unordered_map

**`map`**：红黑树实现，有序，查找/插入/删除 O(log n)。

```cpp
#include <map>

std::map<std::string, float> sensor_values;

// 插入
sensor_values["temp"]  = 25.6f;
sensor_values["humi"]  = 60.0f;
sensor_values.insert({"pressure", 1013.0f});
sensor_values.emplace("light", 500.0f);

// 查找
auto it = sensor_values.find("temp");
if (it != sensor_values.end()) {
    float val = it->second;  // it->first 是 key，it->second 是 value
}

// 用 [] 访问不存在的 key 会自动插入默认值，小心
float v = sensor_values["unknown"];  // 插入了一个 0.0f 的条目

// count 检查 key 是否存在（不会插入）
if (sensor_values.count("temp")) { }

// C++20 的 contains（更直观）
if (sensor_values.contains("temp")) { }

// 遍历（按 key 有序）
for (const auto &[key, val] : sensor_values) {
    printf("%s: %.2f\n", key.c_str(), val);
}

// 删除
sensor_values.erase("temp");
```

**`unordered_map`**：哈希表实现，无序，平均查找/插入/删除 O(1)，最坏 O(n)。

```cpp
#include <unordered_map>

std::unordered_map<uint32_t, DeviceInfo> devices;
devices[0x1234] = {/* ... */};
```

选哪个：需要有序遍历用 `map`，只需要快速查找用 `unordered_map`。`unordered_map` 平均性能更好，但哈希碰撞时会退化，且内存占用通常比 `map` 多。

---

## 三、string

`std::string` 是字符串的标准容器，本质是 `vector<char>` 加上字符串专用操作。

```cpp
#include <string>

std::string s = "hello";
s += " world";           // 拼接
s.append("!");           // 同上
s.size();                // 长度，不含 '\0'
s.length();              // 同 size()
s.empty();               // 是否为空
s.c_str();               // 返回 const char*，和 C 接口互操作
s[0];                    // 访问字符，不检查越界
s.at(0);                 // 检查越界

// 查找
size_t pos = s.find("world");
if (pos != std::string::npos) {
    // 找到了，pos 是位置
}

// 截取子串
std::string sub = s.substr(6, 5);  // 从第 6 位起，取 5 个字符

// 比较
s == "hello world!";   // true
s.compare("abc");      // 0 相等，<0 小于，>0 大于

// 数字转字符串
std::string num = std::to_string(42);
std::string flt = std::to_string(3.14f);

// 字符串转数字
int   i = std::stoi("42");
float f = std::stof("3.14");
```

**SSO（Small String Optimization）**

大多数标准库实现对短字符串（通常 15 字节以内）会直接存在对象内部，不做堆分配。所以短字符串的 `string` 没有动态内存开销。

---

## 四、其他常用容器速查

**`array`**：固定大小数组，编译期确定，栈上分配，比裸数组多了 `size()`、迭代器等接口：

```cpp
#include <array>
std::array<uint8_t, 8> mac_addr = {0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E};
mac_addr.size();   // 8，编译期常量
```

**`deque`**：双端队列，两端插入删除 O(1)，中间插入 O(n)，内存不连续：

```cpp
#include <deque>
std::deque<int> dq;
dq.push_front(1);
dq.push_back(2);
dq.pop_front();
```

**`list`**：双向链表，任意位置插入删除 O(1)，不支持随机访问，内存不连续，cache 不友好：

```cpp
#include <list>
std::list<int> lst = {1, 2, 3};
lst.push_front(0);
lst.sort();
```

**`set` / `unordered_set`**：不重复元素的有序/无序集合：

```cpp
#include <set>
std::set<int> s = {3, 1, 2, 1};  // {1, 2, 3}，自动去重且有序
s.insert(4);
s.count(1);   // 1 存在返回 1，否则 0
```

**`queue` / `stack` / `priority_queue`**：适配器容器：

```cpp
#include <queue>
std::queue<SensorData> q;
q.push(data);
q.front();     // 队头
q.pop();       // 出队

std::stack<int> stk;
stk.push(1);
stk.top();
stk.pop();

std::priority_queue<int> pq;  // 默认最大堆
pq.push(3);
pq.push(1);
pq.top();   // 3
```

---

## 五、容器选型速查

| 需求 | 容器 |
|------|------|
| 随机访问、尾部增删 | `vector` |
| 固定大小数组 | `array` |
| 两端增删 | `deque` |
| 任意位置增删频繁 | `list` |
| key-value，有序 | `map` |
| key-value，快速查找 | `unordered_map` |
| 唯一元素集合 | `set` / `unordered_set` |
| FIFO | `queue` |
| LIFO | `stack` |
| 优先级队列 | `priority_queue` |

---

## 六、嵌入式里的注意事项

STL 容器几乎都依赖动态内存，在裸机 MCU 上使用需要谨慎：

**堆内存问题**：`vector`、`map`、`string` 都会调用 `new/delete`，裸机上堆空间有限，且标准 `malloc` 实现可能有碎片问题。如果 MCU 的堆只有几 KB，随意使用 STL 容器很容易 OOM。

**`array` 是例外**：`std::array` 不做动态分配，完全可以在裸机上放心用，是裸数组的升级替代品。

**`string` 的 SSO**：短字符串不堆分配，临时拼接日志、状态名等短字符串问题不大。长字符串谨慎。

**Linux 嵌入式**：有 MMU 和完整的内存管理，STL 容器开箱即用，和 PC 开发没有区别。

**替代方案**：对内存敏感的场合，可以用第五篇模板章节里实现的 `RingBuffer`，或者 ETL（Embedded Template Library）—— 专门为嵌入式设计的 STL 替代品，所有容器都使用固定大小、静态分配。

---

## 总结

- `vector`：最常用，动态数组，随机访问 O(1)，扩容时用 `reserve` 避免多次重分配
- `map`：红黑树，有序 key-value，O(log n)；`unordered_map` 哈希表，平均 O(1)
- `string`：字符串容器，短字符串 SSO 无堆分配，和 C 接口用 `c_str()` 互通
- `array`：固定大小，栈上分配，嵌入式裸机上最安全的容器
- 裸机 MCU 上 STL 容器用之前先想清楚堆内存够不够，`array` 是最安全的选择
