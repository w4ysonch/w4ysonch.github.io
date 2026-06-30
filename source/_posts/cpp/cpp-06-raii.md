---
title: "C++ 学习笔记（六）：RAII——资源管理的核心思想"
date: 2025-05-05T17:12:45+08:00
categories: ["C/C++"]
tags: ["C++", "嵌入式", "学习笔记"]
cover: /images/cpp_note/cover.png
top_img: false
---

RAII 全称 Resource Acquisition Is Initialization，直译是"资源获取即初始化"，但这个名字没有把最重要的部分说清楚——真正的核心是**资源释放和对象生命周期绑定**。对象构造时获取资源，析构时释放资源，析构由编译器保证调用，资源就不会泄漏。

---

## 一、没有 RAII 的世界

C 里管理资源的典型写法：

```c
void process(void) {
    uint8_t *buf = malloc(256);
    if (!buf) return;

    FILE *f = fopen("log.txt", "w");
    if (!f) {
        free(buf);   // 别忘了释放 buf
        return;
    }

    if (some_error()) {
        fclose(f);   // 别忘了关文件
        free(buf);   // 别忘了释放 buf
        return;
    }

    // 正常路径
    fclose(f);
    free(buf);
}
```

每条退出路径都要手动释放所有资源。函数越长、分支越多，漏掉一个的概率就越高。这是 C 项目里内存泄漏和资源泄漏的主要来源。

---

## 二、RAII 的做法

把资源封装进对象，析构函数负责释放：

```cpp
class Buffer {
public:
    Buffer(size_t size) : ptr_(new uint8_t[size]) {}
    ~Buffer() { delete[] ptr_; }

    uint8_t *get() { return ptr_; }

private:
    uint8_t *ptr_;

    Buffer(const Buffer &) = delete;
    Buffer &operator=(const Buffer &) = delete;
};

class FileHandle {
public:
    FileHandle(const char *path, const char *mode)
        : f_(fopen(path, mode)) {}
    ~FileHandle() { if (f_) fclose(f_); }

    bool ok() const { return f_ != nullptr; }
    FILE *get() { return f_; }

private:
    FILE *f_;

    FileHandle(const FileHandle &) = delete;
    FileHandle &operator=(const FileHandle &) = delete;
};
```

同样的逻辑用 RAII 写：

```cpp
void process(void) {
    Buffer buf(256);
    FileHandle f("log.txt", "w");

    if (!f.ok()) return;   // f 和 buf 的析构函数自动调用

    if (some_error()) return;  // 同上，自动清理

    // 正常路径退出，同样自动清理
}
```

不管从哪条路径退出，`buf` 和 `f` 离开作用域时析构函数必然被调用。不需要记住释放顺序，不需要在每个 `return` 前重复写清理代码。

---

## 三、RAII 在嵌入式里的场景

嵌入式里"资源"不只是内存，还包括：

**互斥锁**

```cpp
class LockGuard {
public:
    LockGuard(Mutex &m) : mutex_(m) { mutex_.lock(); }
    ~LockGuard() { mutex_.unlock(); }

private:
    Mutex &mutex_;

    LockGuard(const LockGuard &) = delete;
    LockGuard &operator=(const LockGuard &) = delete;
};

void update_shared_data(void) {
    LockGuard guard(g_mutex);  // 加锁
    // 操作共享数据
    // ...
}   // guard 析构，自动解锁
```

不管函数从哪里返回，锁一定会被释放。这是 FreeRTOS 项目里避免死锁的常用手段。

**关中断**

```cpp
class CriticalSection {
public:
    CriticalSection()  { taskENTER_CRITICAL(); }
    ~CriticalSection() { taskEXIT_CRITICAL();  }

private:
    CriticalSection(const CriticalSection &) = delete;
    CriticalSection &operator=(const CriticalSection &) = delete;
};

void isr_safe_update(void) {
    CriticalSection cs;
    g_counter++;
}   // 自动退出临界区
```

**GPIO 片选信号**

SPI 通信里 CS 拉低开始传输，传完拉高。用 RAII 保证 CS 不会因为中途出错而一直拉低：

```cpp
class SpiTransaction {
public:
    SpiTransaction(GpioPin &cs) : cs_(cs) { cs_.set(false); }  // CS 拉低
    ~SpiTransaction()                      { cs_.set(true);  }  // CS 拉高

private:
    GpioPin &cs_;

    SpiTransaction(const SpiTransaction &) = delete;
    SpiTransaction &operator=(const SpiTransaction &) = delete;
};

bool read_sensor(void) {
    SpiTransaction tx(g_cs_pin);   // CS 拉低
    if (!spi_write(cmd)) return false;  // 失败时 CS 也会被拉高
    spi_read(buf, len);
    return true;
}   // CS 拉高
```

---

## 四、标准库里的 RAII

C++ 标准库里到处是 RAII：

**`std::unique_ptr` / `std::shared_ptr`**

智能指针是 RAII 管理动态内存的标准方案，`unique_ptr` 和 `shared_ptr` 都是这个思路的具体实现。

**`std::lock_guard` / `std::unique_lock`**

标准库提供的互斥锁 RAII 封装，和上面手写的 `LockGuard` 原理一样：

```cpp
#include <mutex>

std::mutex mtx;

void thread_safe_func(void) {
    std::lock_guard<std::mutex> guard(mtx);
    // 临界区
}   // 自动解锁
```

`std::unique_lock` 比 `lock_guard` 多一些功能，支持延迟加锁、条件变量等，灵活性更高但开销略大。

**`std::fstream`**

文件流对象析构时自动关闭文件，不需要手动 `close()`：

```cpp
#include <fstream>

void write_log(const char *msg) {
    std::ofstream f("log.txt", std::ios::app);
    if (!f) return;
    f << msg << "\n";
}   // f 析构，文件自动关闭
```

---

## 五、RAII 的边界

RAII 不是万能的，有几个需要注意的地方：

**析构函数不能抛异常**

如果析构函数抛出异常，程序会直接终止（`std::terminate`）。析构函数里的清理操作要确保不会失败，或者失败时静默处理：

```cpp
~FileHandle() {
    if (f_) {
        fclose(f_);  // 忽略返回值，析构里不处理错误
        f_ = nullptr;
    }
}
```

**循环引用**

`shared_ptr` 互相持有对方会导致两者都无法析构，引用计数永远不归零，资源永远不释放。`weak_ptr` 是解决这个问题的，它持有对象的弱引用，不增加引用计数。

**裸机嵌入式**

C++ 的异常机制（`try/catch`）依赖栈展开（stack unwinding）来保证 RAII 析构调用。大多数嵌入式工程会用 `-fno-exceptions` 禁用异常，这种情况下通过 `return` 正常退出作用域，析构依然正常调用，RAII 不受影响。只有在 `std::terminate` 或者硬件复位时析构才不会被调用——这是合理的，设备都复位了也不需要清理资源。

---

## 六、写好 RAII 类的几个要点

1. **禁止拷贝**：管理独占资源的类（锁、文件句柄、硬件外设）应该 `= delete` 拷贝构造和赋值运算符，避免两个对象持有同一个资源，析构时 double free。

2. **允许移动**：如果需要转移所有权（比如从函数返回一个 RAII 对象），实现移动构造和移动赋值，移动后原对象不再持有资源。

3. **构造失败的处理**：如果资源获取可能失败（`malloc` 返回 `nullptr`、`fopen` 返回 `nullptr`），构造函数要能表达失败状态，提供 `bool ok()` 或 `operator bool()` 让调用方检查。

4. **析构要幂等**：防止移动后对象被析构两次：

```cpp
~Buffer() {
    delete[] ptr_;
    ptr_ = nullptr;   // 防止 double free
}
```

---

## 总结

- RAII 的本质：把资源和对象生命周期绑定，析构函数负责释放
- 不管从哪条路径退出作用域，析构函数必然被调用
- 嵌入式里常见的 RAII 场景：互斥锁、关中断、SPI 片选、DMA buffer
- 标准库的 `lock_guard`、智能指针、`fstream` 都是 RAII 的实现
- 禁用异常不影响 RAII——正常退出作用域析构照常调用
