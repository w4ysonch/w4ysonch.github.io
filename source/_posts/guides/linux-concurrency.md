---
title: "Linux 并发编程：线程、锁与同步"
date: 2025-11-16T18:36:41+08:00
categories: ["知识向"]
tags: ["Linux", "并发", "C", "C++", "pthread"]
cover: /images/guides/linux-concurrency/cover.png
top_img: false
---

单线程程序按顺序执行，简单但低效——等待 I/O 的时候 CPU 闲着，多核处理器只用了一个核。并发编程让程序同时做多件事，充分利用硬件资源。

代价是复杂度：多个线程共享内存，同时读写同一块数据会出问题，需要同步机制来协调。这篇从线程基础讲起，覆盖 pthread（POSIX 标准）和 C++11 并发接口，并与 FreeRTOS 做对比，帮你建立完整的并发编程认知。

---

## 一、线程基础

### 线程是什么

线程是进程内的执行单元。一个进程可以有多个线程，这些线程共享同一块地址空间——代码段、堆、全局变量都是共享的，但每个线程有自己独立的栈和寄存器状态。

和进程的区别：

| | 进程 | 线程 |
|---|---|---|
| 地址空间 | 独立 | 共享（同进程内） |
| 创建开销 | 大（fork 要复制页表） | 小 |
| 通信方式 | IPC（管道、共享内存） | 直接读写共享变量 |
| 崩溃影响 | 不影响其他进程 | 一个线程崩溃可能导致整个进程崩溃 |

线程共享的资源：堆内存、全局变量、文件描述符、信号处理。
线程独占的资源：栈、寄存器、线程局部存储（TLS）、errno。

和 FreeRTOS 任务对比：FreeRTOS 的任务本质上就是线程，每个任务有独立的栈，共享全局内存。区别在于 FreeRTOS 运行在裸机上，调度器由 RTOS 内核管理；Linux 线程由内核调度，底层是 `clone()` 系统调用。

### pthread：创建和等待线程

POSIX 线程（pthread）是 Linux 下线程的标准接口，编译需要加 `-lpthread`。

```c
int pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                   void *(*start_routine)(void *), void *arg);
```
- `thread`：输出参数，存储新线程的 ID
- `attr`：线程属性，通常传 `NULL` 使用默认值
- `start_routine`：线程入口函数，签名必须是 `void* func(void*)`
- `arg`：传给入口函数的参数，只能传一个指针，多个参数用结构体包装

```c
int pthread_join(pthread_t thread, void **retval);
```
- 等待指定线程结束，类似进程的 `waitpid`
- `retval`：获取线程返回值，不关心传 `NULL`
- 不调用 `pthread_join` 会造成资源泄漏（线程变成"僵尸线程"）

基本用法：

```c
#include <pthread.h>
#include <stdio.h>

void* worker(void* arg) {
    int id = *(int*)arg;
    printf("线程 %d 运行中\n", id);
    return NULL;
}

int main() {
    pthread_t t1, t2;
    int id1 = 1, id2 = 2;

    pthread_create(&t1, NULL, worker, &id1);
    pthread_create(&t2, NULL, worker, &id2);

    pthread_join(t1, NULL);
    pthread_join(t2, NULL);

    printf("两个线程都结束了\n");
    return 0;
}
```

### C++11 std::thread

C++11 提供了更简洁的线程接口，不需要手动转换函数指针：

```cpp
#include <thread>
#include <iostream>

void worker(int id) {
    std::cout << "线程 " << id << " 运行中\n";
}

int main() {
    std::thread t1(worker, 1);  // 直接传函数和参数
    std::thread t2(worker, 2);

    t1.join();
    t2.join();
    return 0;
}
```

也可以用 lambda：

```cpp
std::thread t([](int id) {
    std::cout << "线程 " << id << "\n";
}, 42);
t.join();
```

`std::thread` 对象销毁前必须调用 `join()` 或 `detach()`，否则程序会调用 `std::terminate()` 崩溃。`detach()` 让线程在后台独立运行，主线程不等它，适合不需要返回值的后台任务。

---

## 二、mutex：互斥锁

### 竞态条件

多个线程同时读写共享变量时，结果取决于线程执行的先后顺序，这叫**竞态条件（race condition）**。

```c
// 全局计数器，两个线程各加 100000 次
int counter = 0;

void* increment(void* arg) {
    for (int i = 0; i < 100000; i++) {
        counter++;  // 不是原子操作！
    }
    return NULL;
}
```

`counter++` 看起来是一条语句，实际上是三步：读取 → 加一 → 写回。两个线程可能同时读到同一个值，各自加一后写回，导致一次加法丢失。两个线程各加 100000 次，结果可能远小于 200000。

### pthread_mutex

mutex（互斥量）保证同一时刻只有一个线程进入临界区：

```c
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;  // 静态初始化
```

或者动态初始化：

```c
pthread_mutex_t mutex;
pthread_mutex_init(&mutex, NULL);
// 用完后：
pthread_mutex_destroy(&mutex);
```

核心 API：

```c
int pthread_mutex_lock(pthread_mutex_t *mutex);    // 加锁，已锁则阻塞等待
int pthread_mutex_trylock(pthread_mutex_t *mutex); // 尝试加锁，失败立即返回 EBUSY
int pthread_mutex_unlock(pthread_mutex_t *mutex);  // 解锁
```

修复上面的竞态条件：

```c
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
int counter = 0;

void* increment(void* arg) {
    for (int i = 0; i < 100000; i++) {
        pthread_mutex_lock(&mutex);
        counter++;
        pthread_mutex_unlock(&mutex);
    }
    return NULL;
}
```

加锁后只有一个线程能进入 `counter++`，另一个线程阻塞等待，保证操作不会交叉。

### C++11 std::mutex

C++11 的 mutex 接口更安全，配合 RAII 封装避免忘记解锁：

```cpp
#include <mutex>

std::mutex mtx;
int counter = 0;

void increment() {
    for (int i = 0; i < 100000; i++) {
        std::lock_guard<std::mutex> lock(mtx);  // 构造时加锁，析构时自动解锁
        counter++;
    }  // lock 离开作用域，自动解锁
}
```

`lock_guard` 是最简单的 RAII 锁，构造加锁，析构解锁，不能手动解锁。需要中途解锁用 `unique_lock`：

```cpp
std::unique_lock<std::mutex> lock(mtx);
counter++;
lock.unlock();   // 手动解锁
// 做一些不需要锁的事
lock.lock();     // 重新加锁
```

`unique_lock` 更灵活，也是条件变量必须配合的锁类型。

### 与 FreeRTOS mutex 对比

FreeRTOS 的 mutex 和 pthread mutex 概念相同，API 不同：

```c
// FreeRTOS
SemaphoreHandle_t mutex = xSemaphoreCreateMutex();
xSemaphoreTake(mutex, portMAX_DELAY);  // 加锁
xSemaphoreGive(mutex);                 // 解锁

// pthread
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_mutex_lock(&mutex);
pthread_mutex_unlock(&mutex);
```

关键区别：FreeRTOS mutex 支持优先级继承（防止优先级反转），pthread mutex 默认不支持，需要设置 `PTHREAD_PRIO_INHERIT` 属性。

---

## 三、条件变量

### 光有锁不够

mutex 解决了"同时只有一个人操作"的问题，但有些场景需要线程等待某个条件成立。比如生产者消费者模型：消费者从队列取数据，队列为空时应该等待，不能一直空转占 CPU。

用 mutex 轮询是一种写法，但很低效：

```c
// 低效的忙等待，浪费 CPU
while (queue_empty()) {
    pthread_mutex_unlock(&mutex);
    usleep(1000);
    pthread_mutex_lock(&mutex);
}
```

条件变量让线程在条件不满足时**阻塞睡眠**，条件满足时被唤醒，不占 CPU。

### pthread_cond

```c
pthread_cond_t cond = PTHREAD_COND_INITIALIZER;

// 等待条件（必须在持有 mutex 的情况下调用）
int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex);

// 唤醒一个等待的线程
int pthread_cond_signal(pthread_cond_t *cond);

// 唤醒所有等待的线程
int pthread_cond_broadcast(pthread_cond_t *cond);
```

`pthread_cond_wait` 做了三件事：解锁 mutex → 阻塞等待 → 被唤醒后重新加锁。这三步是原子的，保证不会错过信号。

生产者消费者完整示例：

```c
#include <pthread.h>
#include <stdio.h>

#define QUEUE_SIZE 10

int queue[QUEUE_SIZE];
int head = 0, tail = 0, count = 0;

pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t not_empty = PTHREAD_COND_INITIALIZER;
pthread_cond_t not_full  = PTHREAD_COND_INITIALIZER;

void* producer(void* arg) {
    for (int i = 0; i < 20; i++) {
        pthread_mutex_lock(&mutex);

        while (count == QUEUE_SIZE) {
            pthread_cond_wait(&not_full, &mutex);
        }

        queue[tail] = i;
        tail = (tail + 1) % QUEUE_SIZE;
        count++;
        printf("生产：%d\n", i);

        pthread_cond_signal(&not_empty);
        pthread_mutex_unlock(&mutex);
    }
    return NULL;
}

void* consumer(void* arg) {
    for (int i = 0; i < 20; i++) {
        pthread_mutex_lock(&mutex);

        while (count == 0) {
            pthread_cond_wait(&not_empty, &mutex);
        }

        int val = queue[head];
        head = (head + 1) % QUEUE_SIZE;
        count--;
        printf("消费：%d\n", val);

        pthread_cond_signal(&not_full);
        pthread_mutex_unlock(&mutex);
    }
    return NULL;
}
```

注意等待条件用 `while` 而不是 `if`，原因是**虚假唤醒**：线程可能在没有收到信号的情况下被唤醒（POSIX 标准允许这种情况），用 `while` 唤醒后重新检查条件，确保条件真的满足再继续。

### C++11 std::condition_variable

```cpp
#include <condition_variable>
#include <mutex>
#include <queue>

std::mutex mtx;
std::condition_variable cv;
std::queue<int> q;

void producer() {
    for (int i = 0; i < 20; i++) {
        std::unique_lock<std::mutex> lock(mtx);
        q.push(i);
        cv.notify_one();
    }
}

void consumer() {
    for (int i = 0; i < 20; i++) {
        std::unique_lock<std::mutex> lock(mtx);
        cv.wait(lock, [] { return !q.empty(); });  // 自动处理虚假唤醒
        int val = q.front();
        q.pop();
        printf("消费：%d\n", val);
    }
}
```

`cv.wait(lock, predicate)` 内部等价于 `while (!predicate()) cv.wait(lock)`，自动处理了虚假唤醒，比 pthread 写法更安全。

### 与 FreeRTOS 对比

FreeRTOS 里生产者消费者直接用队列 `xQueueSend` / `xQueueReceive`，队列满或空时自动阻塞，内部封装了条件变量的逻辑。Linux 下需要自己用条件变量实现这个机制，或者使用 `std::queue` + 条件变量封装成类似的接口。

---

## 四、读写锁

### 读多写少的场景

mutex 每次只允许一个线程进入，包括只读操作。但实际上多个线程同时读同一块数据是安全的，没有必要互斥。读写锁区分了两种操作：

- **读锁（共享锁）**：多个线程可以同时持有读锁
- **写锁（独占锁）**：写锁同一时刻只有一个线程持有，且持有写锁时不允许任何读锁

适合读操作远多于写操作的场景，比如配置表、路由表、缓存。

### pthread_rwlock

```c
pthread_rwlock_t rwlock = PTHREAD_RWLOCK_INITIALIZER;

int pthread_rwlock_rdlock(pthread_rwlock_t *rwlock);   // 加读锁
int pthread_rwlock_wrlock(pthread_rwlock_t *rwlock);   // 加写锁
int pthread_rwlock_unlock(pthread_rwlock_t *rwlock);   // 解锁（读写通用）
```

```c
// 多个线程可以同时读
void* reader(void* arg) {
    pthread_rwlock_rdlock(&rwlock);
    printf("读取数据：%d\n", shared_data);
    pthread_rwlock_unlock(&rwlock);
    return NULL;
}

// 写操作独占
void* writer(void* arg) {
    pthread_rwlock_wrlock(&rwlock);
    shared_data++;
    pthread_rwlock_unlock(&rwlock);
    return NULL;
}
```

### C++17 std::shared_mutex

C++11 没有原生读写锁，C++17 引入了 `std::shared_mutex`：

```cpp
#include <shared_mutex>

std::shared_mutex rw_mtx;

// 读：用 shared_lock，允许多个线程同时持有
void reader() {
    std::shared_lock<std::shared_mutex> lock(rw_mtx);
    std::cout << shared_data << "\n";
}

// 写：用 unique_lock，独占
void writer() {
    std::unique_lock<std::shared_mutex> lock(rw_mtx);
    shared_data++;
}
```

C++11 环境下可以用 pthread_rwlock 封装，或者用 boost::shared_mutex。

---

## 五、原子操作

### 不用锁的并发

mutex 有开销：加锁解锁涉及系统调用，线程可能阻塞切换。对于简单的计数器、标志位，用原子操作代替锁更高效。

原子操作是硬件保证不可分割的操作，读-改-写三步由 CPU 指令保证原子完成，不会被其他线程打断。

### std::atomic

```cpp
#include <atomic>

std::atomic<int> counter(0);

void increment() {
    for (int i = 0; i < 100000; i++) {
        counter++;  // 原子自增，不需要锁
    }
}
```

常用操作：

```cpp
std::atomic<int> val(0);

val.store(42);           // 原子写
int x = val.load();      // 原子读
val.fetch_add(1);        // 原子加，返回旧值，等价于 val++
val.fetch_sub(1);        // 原子减
val.exchange(10);        // 原子交换，返回旧值

// compare_exchange：比较并交换，实现无锁数据结构的基础
int expected = 0;
val.compare_exchange_strong(expected, 1);
// 如果 val == expected，把 val 改为 1，返回 true
// 否则把 expected 改为 val 的当前值，返回 false
```

### 内存序

`std::atomic` 默认使用 `memory_order_seq_cst`（顺序一致），最安全但性能最低。性能敏感场景可以用更弱的内存序，但需要深入理解 CPU 乱序执行，容易出错。

对于大多数场景，默认内存序足够，不要过早优化：

```cpp
counter.fetch_add(1);                                    // 默认顺序一致
counter.fetch_add(1, std::memory_order_relaxed);         // 最宽松，只保证原子性
```

`std::atomic<bool>` 常用于线程间的标志位通知，比 `volatile bool` 更安全（`volatile` 不保证原子性，只防止编译器优化）。

---

## 六、常见并发问题

### 死锁

死锁是两个或多个线程互相等待对方释放锁，永远卡住。最典型的场景：

```c
// 线程 A
pthread_mutex_lock(&mutex_a);
pthread_mutex_lock(&mutex_b);  // 等待 mutex_b，但 B 持有它

// 线程 B（同时执行）
pthread_mutex_lock(&mutex_b);
pthread_mutex_lock(&mutex_a);  // 等待 mutex_a，但 A 持有它
// 互相等待，死锁
```

避免死锁的方法：

**固定加锁顺序**：所有线程按同一顺序加锁，永远先锁 A 再锁 B，不会形成环。

**使用 trylock + 回退**：

```c
while (1) {
    pthread_mutex_lock(&mutex_a);
    if (pthread_mutex_trylock(&mutex_b) == 0) {
        break;  // 两把锁都拿到了
    }
    pthread_mutex_unlock(&mutex_a);  // 没拿到就都放掉，等一下再试
    usleep(rand() % 1000);
}
```

**C++17 std::scoped_lock**：同时锁多个 mutex，内部用死锁避免算法：

```cpp
std::scoped_lock lock(mutex_a, mutex_b);  // 自动避免死锁
```

### 线程安全的设计原则

**减少共享状态**：共享的数据越少，需要保护的地方越少。能用局部变量的不用全局变量，能用消息传递的不用共享内存。

**锁的粒度尽量小**：只在真正需要保护的地方加锁，不要把整个函数都包进去。锁住的代码越少，并发度越高。

```cpp
// 不好：整个循环都加锁
std::lock_guard<std::mutex> lock(mtx);
for (int i = 0; i < 1000; i++) {
    process(data[i]);  // process 可能很耗时
}

// 好：只在读写共享数据时加锁
for (int i = 0; i < 1000; i++) {
    int val;
    {
        std::lock_guard<std::mutex> lock(mtx);
        val = data[i];
    }
    process(val);  // 拿到数据后解锁，process 不占锁
}
```

**优先用高层抽象**：能用 `std::queue` + 条件变量封装的线程安全队列，不要自己手写锁逻辑。能用 `std::atomic` 的不用 mutex。

### 线程池

每次来一个任务就创建一个线程，用完销毁，开销很大——线程创建涉及内核调用，栈内存分配，频繁创建销毁在高并发场景下会成为瓶颈。

线程池的思路是：预先创建固定数量的线程，这些线程一直存活，等待任务队列里有任务时取出来执行，执行完继续等待下一个任务。创建开销只在启动时发生一次。

线程池由三部分组成：
- **任务队列**：存放待执行的任务，生产者往里放，工作线程从里取
- **工作线程**：固定数量，循环从队列取任务执行
- **同步机制**：mutex 保护队列，条件变量让线程在队列为空时睡眠

用 C++11 实现一个简单线程池：

```cpp
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <vector>
#include <functional>

class ThreadPool {
public:
    ThreadPool(size_t num_threads) : stop(false) {
        for (size_t i = 0; i < num_threads; i++) {
            workers.emplace_back([this] {
                while (true) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(mtx);
                        // 队列为空且没有停止信号，就睡眠等待
                        cv.wait(lock, [this] {
                            return stop || !tasks.empty();
                        });
                        if (stop && tasks.empty()) return;  // 停止且队列清空，退出
                        task = std::move(tasks.front());
                        tasks.pop();
                    }
                    task();  // 在锁外执行任务，不阻塞其他线程取任务
                }
            });
        }
    }

    // 提交任务
    void submit(std::function<void()> task) {
        {
            std::lock_guard<std::mutex> lock(mtx);
            tasks.push(std::move(task));
        }
        cv.notify_one();  // 唤醒一个空闲线程
    }

    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lock(mtx);
            stop = true;
        }
        cv.notify_all();  // 唤醒所有线程，让它们检查 stop 标志退出
        for (auto& t : workers) t.join();
    }

private:
    std::vector<std::thread> workers;
    std::queue<std::function<void()>> tasks;
    std::mutex mtx;
    std::condition_variable cv;
    bool stop;
};
```

使用：

```cpp
ThreadPool pool(4);  // 4 个工作线程

for (int i = 0; i < 10; i++) {
    pool.submit([i] {
        printf("任务 %d 在线程 %lu 执行\n", i, pthread_self());
    });
}
// pool 析构时等待所有任务完成
```

析构函数里设置 `stop = true` 后唤醒所有线程，线程检查到 `stop && tasks.empty()` 就退出，`join` 等待所有线程结束，保证任务全部执行完再销毁。这个模式把线程基础、mutex、条件变量综合在一起，是并发编程里的经典设计。

---

并发编程的核心矛盾是**正确性和性能**：加锁保证正确但降低并发度，去掉锁提高性能但容易出问题。实际开发里先保证正确，再在性能瓶颈处针对性优化。FreeRTOS 和 Linux pthread 的概念是相通的——任务/线程、信号量/mutex、队列/条件变量，换了平台换了 API，背后的思路一样。
