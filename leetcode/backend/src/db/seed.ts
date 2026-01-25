import pool from './pool.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

interface TestCase {
  input: string;
  expected_output: string;
  is_sample: boolean;
}

interface Problem {
  title: string;
  slug: string;
  description: string;
  examples: string;
  constraints: string;
  difficulty: string;
  starter_code_python: string;
  starter_code_javascript: string;
  starter_code_cpp: string;
  starter_code_java: string;
  solution_python: string;
  solution_javascript: string;
  solution_cpp: string;
  solution_java: string;
  test_cases: TestCase[];
}

const problems: Problem[] = [
  {
    title: 'Two Sum',
    slug: 'two-sum',
    description: `Given an array of integers \`nums\` and an integer \`target\`, return indices of the two numbers such that they add up to \`target\`.

You may assume that each input would have exactly one solution, and you may not use the same element twice.

You can return the answer in any order.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [3,2,4], target = 6
Output: [1,2]
\`\`\`

**Example 3:**
\`\`\`
Input: nums = [3,3], target = 6
Output: [0,1]
\`\`\``,
    constraints: `- \`2 <= nums.length <= 10^4\`
- \`-10^9 <= nums[i] <= 10^9\`
- \`-10^9 <= target <= 10^9\`
- Only one valid answer exists.`,
    difficulty: 'easy',
    starter_code_python: `def twoSum(nums, target):
    """
    :type nums: List[int]
    :type target: int
    :rtype: List[int]
    """
    # Your code here
    pass

# Read input
import json
nums = json.loads(input())
target = int(input())
result = twoSum(nums, target)
print(json.dumps(result))`,
    starter_code_javascript: `function twoSum(nums, target) {
    // Your code here
}

// Read input
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = twoSum(nums, target);
    console.log(JSON.stringify(result));
});`,
    solution_python: `def twoSum(nums, target):
    seen = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in seen:
            return [seen[complement], i]
        seen[num] = i
    return []

import json
nums = json.loads(input())
target = int(input())
result = twoSum(nums, target)
print(json.dumps(result))`,
    solution_javascript: `function twoSum(nums, target) {
    const seen = new Map();
    for (let i = 0; i < nums.length; i++) {
        const complement = target - nums[i];
        if (seen.has(complement)) {
            return [seen.get(complement), i];
        }
        seen.set(nums[i], i);
    }
    return [];
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = twoSum(nums, target);
    console.log(JSON.stringify(result));
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <unordered_map>
#include <sstream>
using namespace std;

vector<int> twoSum(vector<int>& nums, int target) {
    // Your code here
    return {};
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) {
        nums.push_back(stoi(num));
    }
    int target;
    cin >> target;
    vector<int> result = twoSum(nums, target);
    cout << "[" << result[0] << "," << result[1] << "]" << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int[] twoSum(int[] nums, int target) {
        // Your code here
        return new int[]{};
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine().trim();
        line = line.substring(1, line.length() - 1);
        String[] parts = line.split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            nums[i] = Integer.parseInt(parts[i].trim());
        }
        int target = Integer.parseInt(sc.nextLine().trim());
        int[] result = twoSum(nums, target);
        System.out.println("[" + result[0] + "," + result[1] + "]");
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <unordered_map>
#include <sstream>
using namespace std;

vector<int> twoSum(vector<int>& nums, int target) {
    unordered_map<int, int> seen;
    for (int i = 0; i < nums.size(); i++) {
        int complement = target - nums[i];
        if (seen.count(complement)) {
            return {seen[complement], i};
        }
        seen[nums[i]] = i;
    }
    return {};
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) {
        nums.push_back(stoi(num));
    }
    int target;
    cin >> target;
    vector<int> result = twoSum(nums, target);
    cout << "[" << result[0] << "," << result[1] << "]" << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            int complement = target - nums[i];
            if (seen.containsKey(complement)) {
                return new int[]{seen.get(complement), i};
            }
            seen.put(nums[i], i);
        }
        return new int[]{};
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine().trim();
        line = line.substring(1, line.length() - 1);
        String[] parts = line.split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            nums[i] = Integer.parseInt(parts[i].trim());
        }
        int target = Integer.parseInt(sc.nextLine().trim());
        int[] result = twoSum(nums, target);
        System.out.println("[" + result[0] + "," + result[1] + "]");
    }
}`,
    test_cases: [
      { input: '[2,7,11,15]\n9', expected_output: '[0,1]', is_sample: true },
      { input: '[3,2,4]\n6', expected_output: '[1,2]', is_sample: true },
      { input: '[3,3]\n6', expected_output: '[0,1]', is_sample: true },
      { input: '[1,2,3,4,5]\n9', expected_output: '[3,4]', is_sample: false },
      { input: '[0,4,3,0]\n0', expected_output: '[0,3]', is_sample: false },
    ]
  },
  {
    title: 'Palindrome Number',
    slug: 'palindrome-number',
    description: `Given an integer \`x\`, return \`true\` if \`x\` is a palindrome, and \`false\` otherwise.

An integer is a palindrome when it reads the same backward as forward.

For example, \`121\` is a palindrome while \`123\` is not.`,
    examples: `**Example 1:**
\`\`\`
Input: x = 121
Output: true
Explanation: 121 reads as 121 from left to right and from right to left.
\`\`\`

**Example 2:**
\`\`\`
Input: x = -121
Output: false
Explanation: From left to right, it reads -121. From right to left, it becomes 121-. Therefore it is not a palindrome.
\`\`\`

**Example 3:**
\`\`\`
Input: x = 10
Output: false
Explanation: Reads 01 from right to left. Therefore it is not a palindrome.
\`\`\``,
    constraints: `- \`-2^31 <= x <= 2^31 - 1\``,
    difficulty: 'easy',
    starter_code_python: `def isPalindrome(x):
    """
    :type x: int
    :rtype: bool
    """
    # Your code here
    pass

x = int(input())
result = isPalindrome(x)
print(str(result).lower())`,
    starter_code_javascript: `function isPalindrome(x) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const x = parseInt(line);
    const result = isPalindrome(x);
    console.log(result);
    rl.close();
});`,
    solution_python: `def isPalindrome(x):
    if x < 0:
        return False
    s = str(x)
    return s == s[::-1]

x = int(input())
result = isPalindrome(x)
print(str(result).lower())`,
    solution_javascript: `function isPalindrome(x) {
    if (x < 0) return false;
    const s = x.toString();
    return s === s.split('').reverse().join('');
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const x = parseInt(line);
    const result = isPalindrome(x);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <string>
#include <algorithm>
using namespace std;

bool isPalindrome(int x) {
    // Your code here
    return false;
}

int main() {
    int x;
    cin >> x;
    cout << (isPalindrome(x) ? "true" : "false") << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static boolean isPalindrome(int x) {
        // Your code here
        return false;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int x = sc.nextInt();
        System.out.println(isPalindrome(x));
    }
}`,
    solution_cpp: `#include <iostream>
#include <string>
#include <algorithm>
using namespace std;

bool isPalindrome(int x) {
    if (x < 0) return false;
    string s = to_string(x);
    string rev = s;
    reverse(rev.begin(), rev.end());
    return s == rev;
}

int main() {
    int x;
    cin >> x;
    cout << (isPalindrome(x) ? "true" : "false") << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static boolean isPalindrome(int x) {
        if (x < 0) return false;
        String s = String.valueOf(x);
        return s.equals(new StringBuilder(s).reverse().toString());
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int x = sc.nextInt();
        System.out.println(isPalindrome(x));
    }
}`,
    test_cases: [
      { input: '121', expected_output: 'true', is_sample: true },
      { input: '-121', expected_output: 'false', is_sample: true },
      { input: '10', expected_output: 'false', is_sample: true },
      { input: '12321', expected_output: 'true', is_sample: false },
      { input: '0', expected_output: 'true', is_sample: false },
    ]
  },
  {
    title: 'Valid Parentheses',
    slug: 'valid-parentheses',
    description: `Given a string \`s\` containing just the characters \`'('\`, \`')'\`, \`'{'\`, \`'}'\`, \`'['\` and \`']'\`, determine if the input string is valid.

An input string is valid if:

1. Open brackets must be closed by the same type of brackets.
2. Open brackets must be closed in the correct order.
3. Every close bracket has a corresponding open bracket of the same type.`,
    examples: `**Example 1:**
\`\`\`
Input: s = "()"
Output: true
\`\`\`

**Example 2:**
\`\`\`
Input: s = "()[]{}"
Output: true
\`\`\`

**Example 3:**
\`\`\`
Input: s = "(]"
Output: false
\`\`\``,
    constraints: `- \`1 <= s.length <= 10^4\`
- \`s\` consists of parentheses only \`'()[]{}'\`.`,
    difficulty: 'easy',
    starter_code_python: `def isValid(s):
    """
    :type s: str
    :rtype: bool
    """
    # Your code here
    pass

s = input().strip()
result = isValid(s)
print(str(result).lower())`,
    starter_code_javascript: `function isValid(s) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = isValid(line.trim());
    console.log(result);
    rl.close();
});`,
    solution_python: `def isValid(s):
    stack = []
    mapping = {')': '(', '}': '{', ']': '['}
    for char in s:
        if char in mapping:
            if not stack or stack.pop() != mapping[char]:
                return False
        else:
            stack.append(char)
    return len(stack) == 0

s = input().strip()
result = isValid(s)
print(str(result).lower())`,
    solution_javascript: `function isValid(s) {
    const stack = [];
    const mapping = { ')': '(', '}': '{', ']': '[' };
    for (const char of s) {
        if (char in mapping) {
            if (stack.length === 0 || stack.pop() !== mapping[char]) {
                return false;
            }
        } else {
            stack.push(char);
        }
    }
    return stack.length === 0;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = isValid(line.trim());
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <stack>
#include <unordered_map>
using namespace std;

bool isValid(string s) {
    // Your code here
    return false;
}

int main() {
    string s;
    getline(cin, s);
    cout << (isValid(s) ? "true" : "false") << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static boolean isValid(String s) {
        // Your code here
        return false;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.nextLine();
        System.out.println(isValid(s));
    }
}`,
    solution_cpp: `#include <iostream>
#include <stack>
#include <unordered_map>
using namespace std;

bool isValid(string s) {
    stack<char> st;
    unordered_map<char, char> mapping = {{')', '('}, {'}', '{'}, {']', '['}};
    for (char c : s) {
        if (mapping.count(c)) {
            if (st.empty() || st.top() != mapping[c]) return false;
            st.pop();
        } else {
            st.push(c);
        }
    }
    return st.empty();
}

int main() {
    string s;
    getline(cin, s);
    cout << (isValid(s) ? "true" : "false") << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static boolean isValid(String s) {
        Stack<Character> stack = new Stack<>();
        Map<Character, Character> mapping = Map.of(')', '(', '}', '{', ']', '[');
        for (char c : s.toCharArray()) {
            if (mapping.containsKey(c)) {
                if (stack.isEmpty() || stack.pop() != mapping.get(c)) return false;
            } else {
                stack.push(c);
            }
        }
        return stack.isEmpty();
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.nextLine();
        System.out.println(isValid(s));
    }
}`,
    test_cases: [
      { input: '()', expected_output: 'true', is_sample: true },
      { input: '()[]{}', expected_output: 'true', is_sample: true },
      { input: '(]', expected_output: 'false', is_sample: true },
      { input: '([{}])', expected_output: 'true', is_sample: false },
      { input: '((()))', expected_output: 'true', is_sample: false },
      { input: '([)]', expected_output: 'false', is_sample: false },
    ]
  },
  {
    title: 'Merge Two Sorted Lists',
    slug: 'merge-two-sorted-lists',
    description: `You are given the heads of two sorted linked lists \`list1\` and \`list2\`.

Merge the two lists into one sorted list. The list should be made by splicing together the nodes of the first two lists.

Return the head of the merged linked list.

**Note:** For this problem, we represent linked lists as arrays for simplicity.`,
    examples: `**Example 1:**
\`\`\`
Input: list1 = [1,2,4], list2 = [1,3,4]
Output: [1,1,2,3,4,4]
\`\`\`

**Example 2:**
\`\`\`
Input: list1 = [], list2 = []
Output: []
\`\`\`

**Example 3:**
\`\`\`
Input: list1 = [], list2 = [0]
Output: [0]
\`\`\``,
    constraints: `- The number of nodes in both lists is in the range \`[0, 50]\`.
- \`-100 <= Node.val <= 100\`
- Both \`list1\` and \`list2\` are sorted in non-decreasing order.`,
    difficulty: 'easy',
    starter_code_python: `def mergeTwoLists(list1, list2):
    """
    :type list1: List[int]
    :type list2: List[int]
    :rtype: List[int]
    """
    # Your code here
    pass

import json
list1 = json.loads(input())
list2 = json.loads(input())
result = mergeTwoLists(list1, list2)
print(json.dumps(result))`,
    starter_code_javascript: `function mergeTwoLists(list1, list2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const list1 = JSON.parse(lines[0]);
    const list2 = JSON.parse(lines[1]);
    const result = mergeTwoLists(list1, list2);
    console.log(JSON.stringify(result));
});`,
    solution_python: `def mergeTwoLists(list1, list2):
    result = []
    i = j = 0
    while i < len(list1) and j < len(list2):
        if list1[i] <= list2[j]:
            result.append(list1[i])
            i += 1
        else:
            result.append(list2[j])
            j += 1
    result.extend(list1[i:])
    result.extend(list2[j:])
    return result

import json
list1 = json.loads(input())
list2 = json.loads(input())
result = mergeTwoLists(list1, list2)
print(json.dumps(result))`,
    solution_javascript: `function mergeTwoLists(list1, list2) {
    const result = [];
    let i = 0, j = 0;
    while (i < list1.length && j < list2.length) {
        if (list1[i] <= list2[j]) {
            result.push(list1[i++]);
        } else {
            result.push(list2[j++]);
        }
    }
    return result.concat(list1.slice(i), list2.slice(j));
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const list1 = JSON.parse(lines[0]);
    const list2 = JSON.parse(lines[1]);
    const result = mergeTwoLists(list1, list2);
    console.log(JSON.stringify(result));
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

vector<int> parseArray(string& line) {
    vector<int> arr;
    if (line == "[]") return arr;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) arr.push_back(stoi(num));
    return arr;
}

vector<int> mergeTwoLists(vector<int>& list1, vector<int>& list2) {
    // Your code here
    return {};
}

int main() {
    string line1, line2;
    getline(cin, line1);
    getline(cin, line2);
    vector<int> list1 = parseArray(line1);
    vector<int> list2 = parseArray(line2);
    vector<int> result = mergeTwoLists(list1, list2);
    cout << "[";
    for (int i = 0; i < result.size(); i++) {
        cout << result[i] << (i < result.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int[] mergeTwoLists(int[] list1, int[] list2) {
        // Your code here
        return new int[]{};
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] list1 = parseArray(sc.nextLine());
        int[] list2 = parseArray(sc.nextLine());
        int[] result = mergeTwoLists(list1, list2);
        System.out.println(Arrays.toString(result).replace(" ", ""));
    }

    static int[] parseArray(String line) {
        if (line.equals("[]")) return new int[0];
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] arr = new int[parts.length];
        for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
        return arr;
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

vector<int> parseArray(string& line) {
    vector<int> arr;
    if (line == "[]") return arr;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) arr.push_back(stoi(num));
    return arr;
}

vector<int> mergeTwoLists(vector<int>& list1, vector<int>& list2) {
    vector<int> result;
    int i = 0, j = 0;
    while (i < list1.size() && j < list2.size()) {
        if (list1[i] <= list2[j]) result.push_back(list1[i++]);
        else result.push_back(list2[j++]);
    }
    while (i < list1.size()) result.push_back(list1[i++]);
    while (j < list2.size()) result.push_back(list2[j++]);
    return result;
}

int main() {
    string line1, line2;
    getline(cin, line1);
    getline(cin, line2);
    vector<int> list1 = parseArray(line1);
    vector<int> list2 = parseArray(line2);
    vector<int> result = mergeTwoLists(list1, list2);
    cout << "[";
    for (int i = 0; i < result.size(); i++) {
        cout << result[i] << (i < result.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int[] mergeTwoLists(int[] list1, int[] list2) {
        int[] result = new int[list1.length + list2.length];
        int i = 0, j = 0, k = 0;
        while (i < list1.length && j < list2.length) {
            if (list1[i] <= list2[j]) result[k++] = list1[i++];
            else result[k++] = list2[j++];
        }
        while (i < list1.length) result[k++] = list1[i++];
        while (j < list2.length) result[k++] = list2[j++];
        return result;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] list1 = parseArray(sc.nextLine());
        int[] list2 = parseArray(sc.nextLine());
        int[] result = mergeTwoLists(list1, list2);
        System.out.println(Arrays.toString(result).replace(" ", ""));
    }

    static int[] parseArray(String line) {
        if (line.equals("[]")) return new int[0];
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] arr = new int[parts.length];
        for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
        return arr;
    }
}`,
    test_cases: [
      { input: '[1,2,4]\n[1,3,4]', expected_output: '[1,1,2,3,4,4]', is_sample: true },
      { input: '[]\n[]', expected_output: '[]', is_sample: true },
      { input: '[]\n[0]', expected_output: '[0]', is_sample: true },
      { input: '[1,5,10]\n[2,3,7,15]', expected_output: '[1,2,3,5,7,10,15]', is_sample: false },
    ]
  },
  {
    title: 'Maximum Subarray',
    slug: 'maximum-subarray',
    description: `Given an integer array \`nums\`, find the subarray with the largest sum, and return its sum.

A subarray is a contiguous non-empty sequence of elements within an array.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [-2,1,-3,4,-1,2,1,-5,4]
Output: 6
Explanation: The subarray [4,-1,2,1] has the largest sum 6.
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [1]
Output: 1
Explanation: The subarray [1] has the largest sum 1.
\`\`\`

**Example 3:**
\`\`\`
Input: nums = [5,4,-1,7,8]
Output: 23
Explanation: The subarray [5,4,-1,7,8] has the largest sum 23.
\`\`\``,
    constraints: `- \`1 <= nums.length <= 10^5\`
- \`-10^4 <= nums[i] <= 10^4\``,
    difficulty: 'medium',
    starter_code_python: `def maxSubArray(nums):
    """
    :type nums: List[int]
    :rtype: int
    """
    # Your code here
    pass

import json
nums = json.loads(input())
result = maxSubArray(nums)
print(result)`,
    starter_code_javascript: `function maxSubArray(nums) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = maxSubArray(nums);
    console.log(result);
    rl.close();
});`,
    solution_python: `def maxSubArray(nums):
    max_sum = nums[0]
    current_sum = nums[0]
    for i in range(1, len(nums)):
        current_sum = max(nums[i], current_sum + nums[i])
        max_sum = max(max_sum, current_sum)
    return max_sum

import json
nums = json.loads(input())
result = maxSubArray(nums)
print(result)`,
    solution_javascript: `function maxSubArray(nums) {
    let maxSum = nums[0];
    let currentSum = nums[0];
    for (let i = 1; i < nums.length; i++) {
        currentSum = Math.max(nums[i], currentSum + nums[i]);
        maxSum = Math.max(maxSum, currentSum);
    }
    return maxSum;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = maxSubArray(nums);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <algorithm>
using namespace std;

int maxSubArray(vector<int>& nums) {
    // Your code here
    return 0;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    cout << maxSubArray(nums) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int maxSubArray(int[] nums) {
        // Your code here
        return 0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        System.out.println(maxSubArray(nums));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <algorithm>
using namespace std;

int maxSubArray(vector<int>& nums) {
    int maxSum = nums[0], currentSum = nums[0];
    for (int i = 1; i < nums.size(); i++) {
        currentSum = max(nums[i], currentSum + nums[i]);
        maxSum = max(maxSum, currentSum);
    }
    return maxSum;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    cout << maxSubArray(nums) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int maxSubArray(int[] nums) {
        int maxSum = nums[0], currentSum = nums[0];
        for (int i = 1; i < nums.length; i++) {
            currentSum = Math.max(nums[i], currentSum + nums[i]);
            maxSum = Math.max(maxSum, currentSum);
        }
        return maxSum;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        System.out.println(maxSubArray(nums));
    }
}`,
    test_cases: [
      { input: '[-2,1,-3,4,-1,2,1,-5,4]', expected_output: '6', is_sample: true },
      { input: '[1]', expected_output: '1', is_sample: true },
      { input: '[5,4,-1,7,8]', expected_output: '23', is_sample: true },
      { input: '[-1,-2,-3,-4]', expected_output: '-1', is_sample: false },
      { input: '[1,2,3,4,5]', expected_output: '15', is_sample: false },
    ]
  },
  {
    title: 'Longest Common Subsequence',
    slug: 'longest-common-subsequence',
    description: `Given two strings \`text1\` and \`text2\`, return the length of their longest common subsequence. If there is no common subsequence, return \`0\`.

A subsequence of a string is a new string generated from the original string with some characters (can be none) deleted without changing the relative order of the remaining characters.

For example, \`"ace"\` is a subsequence of \`"abcde"\`.

A common subsequence of two strings is a subsequence that is common to both strings.`,
    examples: `**Example 1:**
\`\`\`
Input: text1 = "abcde", text2 = "ace"
Output: 3
Explanation: The longest common subsequence is "ace" and its length is 3.
\`\`\`

**Example 2:**
\`\`\`
Input: text1 = "abc", text2 = "abc"
Output: 3
Explanation: The longest common subsequence is "abc" and its length is 3.
\`\`\`

**Example 3:**
\`\`\`
Input: text1 = "abc", text2 = "def"
Output: 0
Explanation: There is no such common subsequence, so the result is 0.
\`\`\``,
    constraints: `- \`1 <= text1.length, text2.length <= 1000\`
- \`text1\` and \`text2\` consist of only lowercase English characters.`,
    difficulty: 'medium',
    starter_code_python: `def longestCommonSubsequence(text1, text2):
    """
    :type text1: str
    :type text2: str
    :rtype: int
    """
    # Your code here
    pass

text1 = input().strip()
text2 = input().strip()
result = longestCommonSubsequence(text1, text2)
print(result)`,
    starter_code_javascript: `function longestCommonSubsequence(text1, text2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line.trim()));
rl.on('close', () => {
    const result = longestCommonSubsequence(lines[0], lines[1]);
    console.log(result);
});`,
    solution_python: `def longestCommonSubsequence(text1, text2):
    m, n = len(text1), len(text2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if text1[i-1] == text2[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
    return dp[m][n]

text1 = input().strip()
text2 = input().strip()
result = longestCommonSubsequence(text1, text2)
print(result)`,
    solution_javascript: `function longestCommonSubsequence(text1, text2) {
    const m = text1.length, n = text2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (text1[i-1] === text2[j-1]) {
                dp[i][j] = dp[i-1][j-1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
            }
        }
    }
    return dp[m][n];
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line.trim()));
rl.on('close', () => {
    const result = longestCommonSubsequence(lines[0], lines[1]);
    console.log(result);
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

int longestCommonSubsequence(string text1, string text2) {
    // Your code here
    return 0;
}

int main() {
    string text1, text2;
    getline(cin, text1);
    getline(cin, text2);
    cout << longestCommonSubsequence(text1, text2) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int longestCommonSubsequence(String text1, String text2) {
        // Your code here
        return 0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String text1 = sc.nextLine();
        String text2 = sc.nextLine();
        System.out.println(longestCommonSubsequence(text1, text2));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

int longestCommonSubsequence(string text1, string text2) {
    int m = text1.size(), n = text2.size();
    vector<vector<int>> dp(m + 1, vector<int>(n + 1, 0));
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (text1[i-1] == text2[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
            else dp[i][j] = max(dp[i-1][j], dp[i][j-1]);
        }
    }
    return dp[m][n];
}

int main() {
    string text1, text2;
    getline(cin, text1);
    getline(cin, text2);
    cout << longestCommonSubsequence(text1, text2) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int longestCommonSubsequence(String text1, String text2) {
        int m = text1.length(), n = text2.length();
        int[][] dp = new int[m + 1][n + 1];
        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (text1.charAt(i-1) == text2.charAt(j-1)) dp[i][j] = dp[i-1][j-1] + 1;
                else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
            }
        }
        return dp[m][n];
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String text1 = sc.nextLine();
        String text2 = sc.nextLine();
        System.out.println(longestCommonSubsequence(text1, text2));
    }
}`,
    test_cases: [
      { input: 'abcde\nace', expected_output: '3', is_sample: true },
      { input: 'abc\nabc', expected_output: '3', is_sample: true },
      { input: 'abc\ndef', expected_output: '0', is_sample: true },
      { input: 'bsbininm\njmjkbkjkv', expected_output: '1', is_sample: false },
    ]
  },
  {
    title: 'Median of Two Sorted Arrays',
    slug: 'median-of-two-sorted-arrays',
    description: `Given two sorted arrays \`nums1\` and \`nums2\` of size \`m\` and \`n\` respectively, return the median of the two sorted arrays.

The overall run time complexity should be O(log (m+n)).`,
    examples: `**Example 1:**
\`\`\`
Input: nums1 = [1,3], nums2 = [2]
Output: 2.0
Explanation: merged array = [1,2,3] and median is 2.
\`\`\`

**Example 2:**
\`\`\`
Input: nums1 = [1,2], nums2 = [3,4]
Output: 2.5
Explanation: merged array = [1,2,3,4] and median is (2 + 3) / 2 = 2.5.
\`\`\``,
    constraints: `- \`nums1.length == m\`
- \`nums2.length == n\`
- \`0 <= m <= 1000\`
- \`0 <= n <= 1000\`
- \`1 <= m + n <= 2000\`
- \`-10^6 <= nums1[i], nums2[i] <= 10^6\``,
    difficulty: 'hard',
    starter_code_python: `def findMedianSortedArrays(nums1, nums2):
    """
    :type nums1: List[int]
    :type nums2: List[int]
    :rtype: float
    """
    # Your code here
    pass

import json
nums1 = json.loads(input())
nums2 = json.loads(input())
result = findMedianSortedArrays(nums1, nums2)
print(result)`,
    starter_code_javascript: `function findMedianSortedArrays(nums1, nums2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums1 = JSON.parse(lines[0]);
    const nums2 = JSON.parse(lines[1]);
    const result = findMedianSortedArrays(nums1, nums2);
    console.log(result);
});`,
    solution_python: `def findMedianSortedArrays(nums1, nums2):
    merged = sorted(nums1 + nums2)
    n = len(merged)
    if n % 2 == 1:
        return float(merged[n // 2])
    else:
        return (merged[n // 2 - 1] + merged[n // 2]) / 2.0

import json
nums1 = json.loads(input())
nums2 = json.loads(input())
result = findMedianSortedArrays(nums1, nums2)
print(result)`,
    solution_javascript: `function findMedianSortedArrays(nums1, nums2) {
    const merged = [...nums1, ...nums2].sort((a, b) => a - b);
    const n = merged.length;
    if (n % 2 === 1) {
        return merged[Math.floor(n / 2)];
    } else {
        return (merged[n / 2 - 1] + merged[n / 2]) / 2;
    }
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums1 = JSON.parse(lines[0]);
    const nums2 = JSON.parse(lines[1]);
    const result = findMedianSortedArrays(nums1, nums2);
    console.log(result);
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <algorithm>
#include <iomanip>
using namespace std;

vector<int> parseArray(string& line) {
    vector<int> arr;
    if (line == "[]") return arr;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) arr.push_back(stoi(num));
    return arr;
}

double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2) {
    // Your code here
    return 0.0;
}

int main() {
    string line1, line2;
    getline(cin, line1);
    getline(cin, line2);
    vector<int> nums1 = parseArray(line1);
    vector<int> nums2 = parseArray(line2);
    cout << fixed << setprecision(1) << findMedianSortedArrays(nums1, nums2) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static double findMedianSortedArrays(int[] nums1, int[] nums2) {
        // Your code here
        return 0.0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] nums1 = parseArray(sc.nextLine());
        int[] nums2 = parseArray(sc.nextLine());
        System.out.println(findMedianSortedArrays(nums1, nums2));
    }

    static int[] parseArray(String line) {
        if (line.equals("[]")) return new int[0];
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] arr = new int[parts.length];
        for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
        return arr;
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <algorithm>
#include <iomanip>
using namespace std;

vector<int> parseArray(string& line) {
    vector<int> arr;
    if (line == "[]") return arr;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) arr.push_back(stoi(num));
    return arr;
}

double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2) {
    vector<int> merged;
    merged.insert(merged.end(), nums1.begin(), nums1.end());
    merged.insert(merged.end(), nums2.begin(), nums2.end());
    sort(merged.begin(), merged.end());
    int n = merged.size();
    if (n % 2 == 1) return merged[n / 2];
    return (merged[n / 2 - 1] + merged[n / 2]) / 2.0;
}

int main() {
    string line1, line2;
    getline(cin, line1);
    getline(cin, line2);
    vector<int> nums1 = parseArray(line1);
    vector<int> nums2 = parseArray(line2);
    cout << fixed << setprecision(1) << findMedianSortedArrays(nums1, nums2) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static double findMedianSortedArrays(int[] nums1, int[] nums2) {
        int[] merged = new int[nums1.length + nums2.length];
        System.arraycopy(nums1, 0, merged, 0, nums1.length);
        System.arraycopy(nums2, 0, merged, nums1.length, nums2.length);
        Arrays.sort(merged);
        int n = merged.length;
        if (n % 2 == 1) return merged[n / 2];
        return (merged[n / 2 - 1] + merged[n / 2]) / 2.0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] nums1 = parseArray(sc.nextLine());
        int[] nums2 = parseArray(sc.nextLine());
        System.out.println(findMedianSortedArrays(nums1, nums2));
    }

    static int[] parseArray(String line) {
        if (line.equals("[]")) return new int[0];
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] arr = new int[parts.length];
        for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
        return arr;
    }
}`,
    test_cases: [
      { input: '[1,3]\n[2]', expected_output: '2.0', is_sample: true },
      { input: '[1,2]\n[3,4]', expected_output: '2.5', is_sample: true },
      { input: '[0,0]\n[0,0]', expected_output: '0.0', is_sample: false },
      { input: '[1]\n[2,3,4,5,6]', expected_output: '3.5', is_sample: false },
    ]
  },
  {
    title: 'Reverse String',
    slug: 'reverse-string',
    description: `Write a function that reverses a string. The input string is given as an array of characters \`s\`.

You must do this by modifying the input array in-place with O(1) extra memory.`,
    examples: `**Example 1:**
\`\`\`
Input: s = ["h","e","l","l","o"]
Output: ["o","l","l","e","h"]
\`\`\`

**Example 2:**
\`\`\`
Input: s = ["H","a","n","n","a","h"]
Output: ["h","a","n","n","a","H"]
\`\`\``,
    constraints: `- \`1 <= s.length <= 10^5\`
- \`s[i]\` is a printable ascii character.`,
    difficulty: 'easy',
    starter_code_python: `def reverseString(s):
    """
    :type s: List[str]
    :rtype: None (modify s in-place)
    """
    # Your code here
    pass

import json
s = json.loads(input())
reverseString(s)
print(json.dumps(s))`,
    starter_code_javascript: `function reverseString(s) {
    // Your code here - modify s in-place
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const s = JSON.parse(line);
    reverseString(s);
    console.log(JSON.stringify(s));
    rl.close();
});`,
    solution_python: `def reverseString(s):
    left, right = 0, len(s) - 1
    while left < right:
        s[left], s[right] = s[right], s[left]
        left += 1
        right -= 1

import json
s = json.loads(input())
reverseString(s)
print(json.dumps(s))`,
    solution_javascript: `function reverseString(s) {
    let left = 0, right = s.length - 1;
    while (left < right) {
        [s[left], s[right]] = [s[right], s[left]];
        left++;
        right--;
    }
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const s = JSON.parse(line);
    reverseString(s);
    console.log(JSON.stringify(s));
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

void reverseString(vector<char>& s) {
    // Your code here
}

int main() {
    string line;
    getline(cin, line);
    vector<char> s;
    for (int i = 2; i < line.size() - 1; i += 4) s.push_back(line[i]);
    reverseString(s);
    cout << "[";
    for (int i = 0; i < s.size(); i++) {
        cout << "\\"" << s[i] << "\\"" << (i < s.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static void reverseString(char[] s) {
        // Your code here
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        char[] s = new char[parts.length];
        for (int i = 0; i < parts.length; i++) s[i] = parts[i].trim().charAt(1);
        reverseString(s);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < s.length; i++) {
            sb.append("\\"").append(s[i]).append("\\"");
            if (i < s.length - 1) sb.append(",");
        }
        sb.append("]");
        System.out.println(sb);
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

void reverseString(vector<char>& s) {
    int left = 0, right = s.size() - 1;
    while (left < right) {
        swap(s[left++], s[right--]);
    }
}

int main() {
    string line;
    getline(cin, line);
    vector<char> s;
    for (int i = 2; i < line.size() - 1; i += 4) s.push_back(line[i]);
    reverseString(s);
    cout << "[";
    for (int i = 0; i < s.size(); i++) {
        cout << "\\"" << s[i] << "\\"" << (i < s.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static void reverseString(char[] s) {
        int left = 0, right = s.length - 1;
        while (left < right) {
            char temp = s[left];
            s[left++] = s[right];
            s[right--] = temp;
        }
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        char[] s = new char[parts.length];
        for (int i = 0; i < parts.length; i++) s[i] = parts[i].trim().charAt(1);
        reverseString(s);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < s.length; i++) {
            sb.append("\\"").append(s[i]).append("\\"");
            if (i < s.length - 1) sb.append(",");
        }
        sb.append("]");
        System.out.println(sb);
    }
}`,
    test_cases: [
      { input: '["h","e","l","l","o"]', expected_output: '["o","l","l","e","h"]', is_sample: true },
      { input: '["H","a","n","n","a","h"]', expected_output: '["h","a","n","n","a","H"]', is_sample: true },
      { input: '["a"]', expected_output: '["a"]', is_sample: false },
      { input: '["A","B"]', expected_output: '["B","A"]', is_sample: false },
    ]
  },
  {
    title: 'Climbing Stairs',
    slug: 'climbing-stairs',
    description: `You are climbing a staircase. It takes \`n\` steps to reach the top.

Each time you can either climb \`1\` or \`2\` steps. In how many distinct ways can you climb to the top?`,
    examples: `**Example 1:**
\`\`\`
Input: n = 2
Output: 2
Explanation: There are two ways to climb to the top.
1. 1 step + 1 step
2. 2 steps
\`\`\`

**Example 2:**
\`\`\`
Input: n = 3
Output: 3
Explanation: There are three ways to climb to the top.
1. 1 step + 1 step + 1 step
2. 1 step + 2 steps
3. 2 steps + 1 step
\`\`\``,
    constraints: `- \`1 <= n <= 45\``,
    difficulty: 'easy',
    starter_code_python: `def climbStairs(n):
    """
    :type n: int
    :rtype: int
    """
    # Your code here
    pass

n = int(input())
result = climbStairs(n)
print(result)`,
    starter_code_javascript: `function climbStairs(n) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const n = parseInt(line);
    const result = climbStairs(n);
    console.log(result);
    rl.close();
});`,
    solution_python: `def climbStairs(n):
    if n <= 2:
        return n
    prev, curr = 1, 2
    for _ in range(3, n + 1):
        prev, curr = curr, prev + curr
    return curr

n = int(input())
result = climbStairs(n)
print(result)`,
    solution_javascript: `function climbStairs(n) {
    if (n <= 2) return n;
    let prev = 1, curr = 2;
    for (let i = 3; i <= n; i++) {
        [prev, curr] = [curr, prev + curr];
    }
    return curr;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const n = parseInt(line);
    const result = climbStairs(n);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
using namespace std;

int climbStairs(int n) {
    // Your code here
    return 0;
}

int main() {
    int n;
    cin >> n;
    cout << climbStairs(n) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int climbStairs(int n) {
        // Your code here
        return 0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        System.out.println(climbStairs(n));
    }
}`,
    solution_cpp: `#include <iostream>
using namespace std;

int climbStairs(int n) {
    if (n <= 2) return n;
    int prev = 1, curr = 2;
    for (int i = 3; i <= n; i++) {
        int temp = curr;
        curr = prev + curr;
        prev = temp;
    }
    return curr;
}

int main() {
    int n;
    cin >> n;
    cout << climbStairs(n) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int climbStairs(int n) {
        if (n <= 2) return n;
        int prev = 1, curr = 2;
        for (int i = 3; i <= n; i++) {
            int temp = curr;
            curr = prev + curr;
            prev = temp;
        }
        return curr;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        System.out.println(climbStairs(n));
    }
}`,
    test_cases: [
      { input: '2', expected_output: '2', is_sample: true },
      { input: '3', expected_output: '3', is_sample: true },
      { input: '1', expected_output: '1', is_sample: false },
      { input: '5', expected_output: '8', is_sample: false },
      { input: '10', expected_output: '89', is_sample: false },
    ]
  },
  {
    title: 'Best Time to Buy and Sell Stock',
    slug: 'best-time-to-buy-and-sell-stock',
    description: `You are given an array \`prices\` where \`prices[i]\` is the price of a given stock on the \`i\`th day.

You want to maximize your profit by choosing a single day to buy one stock and choosing a different day in the future to sell that stock.

Return the maximum profit you can achieve from this transaction. If you cannot achieve any profit, return \`0\`.`,
    examples: `**Example 1:**
\`\`\`
Input: prices = [7,1,5,3,6,4]
Output: 5
Explanation: Buy on day 2 (price = 1) and sell on day 5 (price = 6), profit = 6-1 = 5.
Note that buying on day 2 and selling on day 1 is not allowed because you must buy before you sell.
\`\`\`

**Example 2:**
\`\`\`
Input: prices = [7,6,4,3,1]
Output: 0
Explanation: In this case, no transactions are done and the max profit = 0.
\`\`\``,
    constraints: `- \`1 <= prices.length <= 10^5\`
- \`0 <= prices[i] <= 10^4\``,
    difficulty: 'easy',
    starter_code_python: `def maxProfit(prices):
    """
    :type prices: List[int]
    :rtype: int
    """
    # Your code here
    pass

import json
prices = json.loads(input())
result = maxProfit(prices)
print(result)`,
    starter_code_javascript: `function maxProfit(prices) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const prices = JSON.parse(line);
    const result = maxProfit(prices);
    console.log(result);
    rl.close();
});`,
    solution_python: `def maxProfit(prices):
    min_price = float('inf')
    max_profit = 0
    for price in prices:
        min_price = min(min_price, price)
        max_profit = max(max_profit, price - min_price)
    return max_profit

import json
prices = json.loads(input())
result = maxProfit(prices)
print(result)`,
    solution_javascript: `function maxProfit(prices) {
    let minPrice = Infinity;
    let maxProfit = 0;
    for (const price of prices) {
        minPrice = Math.min(minPrice, price);
        maxProfit = Math.max(maxProfit, price - minPrice);
    }
    return maxProfit;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const prices = JSON.parse(line);
    const result = maxProfit(prices);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <climits>
#include <algorithm>
using namespace std;

int maxProfit(vector<int>& prices) {
    // Your code here
    return 0;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> prices;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) prices.push_back(stoi(num));
    cout << maxProfit(prices) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int maxProfit(int[] prices) {
        // Your code here
        return 0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] prices = new int[parts.length];
        for (int i = 0; i < parts.length; i++) prices[i] = Integer.parseInt(parts[i].trim());
        System.out.println(maxProfit(prices));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <climits>
#include <algorithm>
using namespace std;

int maxProfit(vector<int>& prices) {
    int minPrice = INT_MAX, maxProfit = 0;
    for (int price : prices) {
        minPrice = min(minPrice, price);
        maxProfit = max(maxProfit, price - minPrice);
    }
    return maxProfit;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> prices;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) prices.push_back(stoi(num));
    cout << maxProfit(prices) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int maxProfit(int[] prices) {
        int minPrice = Integer.MAX_VALUE, maxProfit = 0;
        for (int price : prices) {
            minPrice = Math.min(minPrice, price);
            maxProfit = Math.max(maxProfit, price - minPrice);
        }
        return maxProfit;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] prices = new int[parts.length];
        for (int i = 0; i < parts.length; i++) prices[i] = Integer.parseInt(parts[i].trim());
        System.out.println(maxProfit(prices));
    }
}`,
    test_cases: [
      { input: '[7,1,5,3,6,4]', expected_output: '5', is_sample: true },
      { input: '[7,6,4,3,1]', expected_output: '0', is_sample: true },
      { input: '[1,2]', expected_output: '1', is_sample: false },
      { input: '[2,4,1]', expected_output: '2', is_sample: false },
      { input: '[3,3,3,3,3]', expected_output: '0', is_sample: false },
    ]
  },
  {
    title: 'Contains Duplicate',
    slug: 'contains-duplicate',
    description: `Given an integer array \`nums\`, return \`true\` if any value appears at least twice in the array, and return \`false\` if every element is distinct.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [1,2,3,1]
Output: true
Explanation: The element 1 occurs at indices 0 and 3.
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [1,2,3,4]
Output: false
Explanation: All elements are distinct.
\`\`\`

**Example 3:**
\`\`\`
Input: nums = [1,1,1,3,3,4,3,2,4,2]
Output: true
\`\`\``,
    constraints: `- \`1 <= nums.length <= 10^5\`
- \`-10^9 <= nums[i] <= 10^9\``,
    difficulty: 'easy',
    starter_code_python: `def containsDuplicate(nums):
    """
    :type nums: List[int]
    :rtype: bool
    """
    # Your code here
    pass

import json
nums = json.loads(input())
result = containsDuplicate(nums)
print(str(result).lower())`,
    starter_code_javascript: `function containsDuplicate(nums) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = containsDuplicate(nums);
    console.log(result);
    rl.close();
});`,
    solution_python: `def containsDuplicate(nums):
    return len(nums) != len(set(nums))

import json
nums = json.loads(input())
result = containsDuplicate(nums)
print(str(result).lower())`,
    solution_javascript: `function containsDuplicate(nums) {
    return nums.length !== new Set(nums).size;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = containsDuplicate(nums);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <unordered_set>
using namespace std;

bool containsDuplicate(vector<int>& nums) {
    // Your code here
    return false;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    cout << (containsDuplicate(nums) ? "true" : "false") << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static boolean containsDuplicate(int[] nums) {
        // Your code here
        return false;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        System.out.println(containsDuplicate(nums));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <unordered_set>
using namespace std;

bool containsDuplicate(vector<int>& nums) {
    unordered_set<int> seen(nums.begin(), nums.end());
    return seen.size() != nums.size();
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    cout << (containsDuplicate(nums) ? "true" : "false") << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static boolean containsDuplicate(int[] nums) {
        Set<Integer> seen = new HashSet<>();
        for (int n : nums) seen.add(n);
        return seen.size() != nums.length;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        System.out.println(containsDuplicate(nums));
    }
}`,
    test_cases: [
      { input: '[1,2,3,1]', expected_output: 'true', is_sample: true },
      { input: '[1,2,3,4]', expected_output: 'false', is_sample: true },
      { input: '[1,1,1,3,3,4,3,2,4,2]', expected_output: 'true', is_sample: true },
      { input: '[1]', expected_output: 'false', is_sample: false },
      { input: '[1,5,9,1]', expected_output: 'true', is_sample: false },
    ]
  },
  {
    title: 'FizzBuzz',
    slug: 'fizzbuzz',
    description: `Given an integer \`n\`, return a string array \`answer\` (1-indexed) where:

- \`answer[i] == "FizzBuzz"\` if \`i\` is divisible by \`3\` and \`5\`.
- \`answer[i] == "Fizz"\` if \`i\` is divisible by \`3\`.
- \`answer[i] == "Buzz"\` if \`i\` is divisible by \`5\`.
- \`answer[i] == i\` (as a string) if none of the above conditions are true.`,
    examples: `**Example 1:**
\`\`\`
Input: n = 3
Output: ["1","2","Fizz"]
\`\`\`

**Example 2:**
\`\`\`
Input: n = 5
Output: ["1","2","Fizz","4","Buzz"]
\`\`\`

**Example 3:**
\`\`\`
Input: n = 15
Output: ["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"]
\`\`\``,
    constraints: `- \`1 <= n <= 10^4\``,
    difficulty: 'easy',
    starter_code_python: `def fizzBuzz(n):
    """
    :type n: int
    :rtype: List[str]
    """
    # Your code here
    pass

import json
n = int(input())
result = fizzBuzz(n)
print(json.dumps(result))`,
    starter_code_javascript: `function fizzBuzz(n) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const n = parseInt(line);
    const result = fizzBuzz(n);
    console.log(JSON.stringify(result));
    rl.close();
});`,
    solution_python: `def fizzBuzz(n):
    result = []
    for i in range(1, n + 1):
        if i % 15 == 0:
            result.append("FizzBuzz")
        elif i % 3 == 0:
            result.append("Fizz")
        elif i % 5 == 0:
            result.append("Buzz")
        else:
            result.append(str(i))
    return result

import json
n = int(input())
result = fizzBuzz(n)
print(json.dumps(result))`,
    solution_javascript: `function fizzBuzz(n) {
    const result = [];
    for (let i = 1; i <= n; i++) {
        if (i % 15 === 0) result.push("FizzBuzz");
        else if (i % 3 === 0) result.push("Fizz");
        else if (i % 5 === 0) result.push("Buzz");
        else result.push(String(i));
    }
    return result;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const n = parseInt(line);
    const result = fizzBuzz(n);
    console.log(JSON.stringify(result));
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <string>
using namespace std;

vector<string> fizzBuzz(int n) {
    // Your code here
    return {};
}

int main() {
    int n;
    cin >> n;
    vector<string> result = fizzBuzz(n);
    cout << "[";
    for (int i = 0; i < result.size(); i++) {
        cout << "\\"" << result[i] << "\\"" << (i < result.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static List<String> fizzBuzz(int n) {
        // Your code here
        return new ArrayList<>();
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        List<String> result = fizzBuzz(n);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < result.size(); i++) {
            sb.append("\\"").append(result.get(i)).append("\\"");
            if (i < result.size() - 1) sb.append(",");
        }
        sb.append("]");
        System.out.println(sb);
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <string>
using namespace std;

vector<string> fizzBuzz(int n) {
    vector<string> result;
    for (int i = 1; i <= n; i++) {
        if (i % 15 == 0) result.push_back("FizzBuzz");
        else if (i % 3 == 0) result.push_back("Fizz");
        else if (i % 5 == 0) result.push_back("Buzz");
        else result.push_back(to_string(i));
    }
    return result;
}

int main() {
    int n;
    cin >> n;
    vector<string> result = fizzBuzz(n);
    cout << "[";
    for (int i = 0; i < result.size(); i++) {
        cout << "\\"" << result[i] << "\\"" << (i < result.size() - 1 ? "," : "");
    }
    cout << "]" << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static List<String> fizzBuzz(int n) {
        List<String> result = new ArrayList<>();
        for (int i = 1; i <= n; i++) {
            if (i % 15 == 0) result.add("FizzBuzz");
            else if (i % 3 == 0) result.add("Fizz");
            else if (i % 5 == 0) result.add("Buzz");
            else result.add(String.valueOf(i));
        }
        return result;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        List<String> result = fizzBuzz(n);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < result.size(); i++) {
            sb.append("\\"").append(result.get(i)).append("\\"");
            if (i < result.size() - 1) sb.append(",");
        }
        sb.append("]");
        System.out.println(sb);
    }
}`,
    test_cases: [
      { input: '3', expected_output: '["1","2","Fizz"]', is_sample: true },
      { input: '5', expected_output: '["1","2","Fizz","4","Buzz"]', is_sample: true },
      { input: '15', expected_output: '["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"]', is_sample: true },
      { input: '1', expected_output: '["1"]', is_sample: false },
    ]
  },
  {
    title: 'Binary Search',
    slug: 'binary-search',
    description: `Given an array of integers \`nums\` which is sorted in ascending order, and an integer \`target\`, write a function to search \`target\` in \`nums\`. If \`target\` exists, then return its index. Otherwise, return \`-1\`.

You must write an algorithm with \`O(log n)\` runtime complexity.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [-1,0,3,5,9,12], target = 9
Output: 4
Explanation: 9 exists in nums and its index is 4
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [-1,0,3,5,9,12], target = 2
Output: -1
Explanation: 2 does not exist in nums so return -1
\`\`\``,
    constraints: `- \`1 <= nums.length <= 10^4\`
- \`-10^4 < nums[i], target < 10^4\`
- All the integers in \`nums\` are unique.
- \`nums\` is sorted in ascending order.`,
    difficulty: 'easy',
    starter_code_python: `def search(nums, target):
    """
    :type nums: List[int]
    :type target: int
    :rtype: int
    """
    # Your code here
    pass

import json
nums = json.loads(input())
target = int(input())
result = search(nums, target)
print(result)`,
    starter_code_javascript: `function search(nums, target) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = search(nums, target);
    console.log(result);
});`,
    solution_python: `def search(nums, target):
    left, right = 0, len(nums) - 1
    while left <= right:
        mid = (left + right) // 2
        if nums[mid] == target:
            return mid
        elif nums[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1

import json
nums = json.loads(input())
target = int(input())
result = search(nums, target)
print(result)`,
    solution_javascript: `function search(nums, target) {
    let left = 0, right = nums.length - 1;
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (nums[mid] === target) return mid;
        else if (nums[mid] < target) left = mid + 1;
        else right = mid - 1;
    }
    return -1;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = search(nums, target);
    console.log(result);
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

int search(vector<int>& nums, int target) {
    // Your code here
    return -1;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    int target;
    cin >> target;
    cout << search(nums, target) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int search(int[] nums, int target) {
        // Your code here
        return -1;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        int target = Integer.parseInt(sc.nextLine().trim());
        System.out.println(search(nums, target));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
using namespace std;

int search(vector<int>& nums, int target) {
    int left = 0, right = nums.size() - 1;
    while (left <= right) {
        int mid = (left + right) / 2;
        if (nums[mid] == target) return mid;
        else if (nums[mid] < target) left = mid + 1;
        else right = mid - 1;
    }
    return -1;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> nums;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) nums.push_back(stoi(num));
    int target;
    cin >> target;
    cout << search(nums, target) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int search(int[] nums, int target) {
        int left = 0, right = nums.length - 1;
        while (left <= right) {
            int mid = (left + right) / 2;
            if (nums[mid] == target) return mid;
            else if (nums[mid] < target) left = mid + 1;
            else right = mid - 1;
        }
        return -1;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] nums = new int[parts.length];
        for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i].trim());
        int target = Integer.parseInt(sc.nextLine().trim());
        System.out.println(search(nums, target));
    }
}`,
    test_cases: [
      { input: '[-1,0,3,5,9,12]\n9', expected_output: '4', is_sample: true },
      { input: '[-1,0,3,5,9,12]\n2', expected_output: '-1', is_sample: true },
      { input: '[5]\n5', expected_output: '0', is_sample: false },
      { input: '[2,5]\n5', expected_output: '1', is_sample: false },
      { input: '[1,2,3,4,5,6,7,8,9,10]\n1', expected_output: '0', is_sample: false },
    ]
  },
  {
    title: 'Coin Change',
    slug: 'coin-change',
    description: `You are given an integer array \`coins\` representing coins of different denominations and an integer \`amount\` representing a total amount of money.

Return the fewest number of coins that you need to make up that amount. If that amount of money cannot be made up by any combination of the coins, return \`-1\`.

You may assume that you have an infinite number of each kind of coin.`,
    examples: `**Example 1:**
\`\`\`
Input: coins = [1,2,5], amount = 11
Output: 3
Explanation: 11 = 5 + 5 + 1
\`\`\`

**Example 2:**
\`\`\`
Input: coins = [2], amount = 3
Output: -1
\`\`\`

**Example 3:**
\`\`\`
Input: coins = [1], amount = 0
Output: 0
\`\`\``,
    constraints: `- \`1 <= coins.length <= 12\`
- \`1 <= coins[i] <= 2^31 - 1\`
- \`0 <= amount <= 10^4\``,
    difficulty: 'medium',
    starter_code_python: `def coinChange(coins, amount):
    """
    :type coins: List[int]
    :type amount: int
    :rtype: int
    """
    # Your code here
    pass

import json
coins = json.loads(input())
amount = int(input())
result = coinChange(coins, amount)
print(result)`,
    starter_code_javascript: `function coinChange(coins, amount) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const coins = JSON.parse(lines[0]);
    const amount = parseInt(lines[1]);
    const result = coinChange(coins, amount);
    console.log(result);
});`,
    solution_python: `def coinChange(coins, amount):
    dp = [float('inf')] * (amount + 1)
    dp[0] = 0
    for i in range(1, amount + 1):
        for coin in coins:
            if coin <= i:
                dp[i] = min(dp[i], dp[i - coin] + 1)
    return dp[amount] if dp[amount] != float('inf') else -1

import json
coins = json.loads(input())
amount = int(input())
result = coinChange(coins, amount)
print(result)`,
    solution_javascript: `function coinChange(coins, amount) {
    const dp = Array(amount + 1).fill(Infinity);
    dp[0] = 0;
    for (let i = 1; i <= amount; i++) {
        for (const coin of coins) {
            if (coin <= i) {
                dp[i] = Math.min(dp[i], dp[i - coin] + 1);
            }
        }
    }
    return dp[amount] === Infinity ? -1 : dp[amount];
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const coins = JSON.parse(lines[0]);
    const amount = parseInt(lines[1]);
    const result = coinChange(coins, amount);
    console.log(result);
});`,
    starter_code_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <climits>
#include <algorithm>
using namespace std;

int coinChange(vector<int>& coins, int amount) {
    // Your code here
    return -1;
}

int main() {
    string line;
    getline(cin, line);
    vector<int> coins;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) coins.push_back(stoi(num));
    int amount;
    cin >> amount;
    cout << coinChange(coins, amount) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int coinChange(int[] coins, int amount) {
        // Your code here
        return -1;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] coins = new int[parts.length];
        for (int i = 0; i < parts.length; i++) coins[i] = Integer.parseInt(parts[i].trim());
        int amount = Integer.parseInt(sc.nextLine().trim());
        System.out.println(coinChange(coins, amount));
    }
}`,
    solution_cpp: `#include <iostream>
#include <vector>
#include <sstream>
#include <climits>
#include <algorithm>
using namespace std;

int coinChange(vector<int>& coins, int amount) {
    vector<int> dp(amount + 1, INT_MAX);
    dp[0] = 0;
    for (int i = 1; i <= amount; i++) {
        for (int coin : coins) {
            if (coin <= i && dp[i - coin] != INT_MAX) {
                dp[i] = min(dp[i], dp[i - coin] + 1);
            }
        }
    }
    return dp[amount] == INT_MAX ? -1 : dp[amount];
}

int main() {
    string line;
    getline(cin, line);
    vector<int> coins;
    stringstream ss(line.substr(1, line.size() - 2));
    string num;
    while (getline(ss, num, ',')) coins.push_back(stoi(num));
    int amount;
    cin >> amount;
    cout << coinChange(coins, amount) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int coinChange(int[] coins, int amount) {
        int[] dp = new int[amount + 1];
        Arrays.fill(dp, amount + 1);
        dp[0] = 0;
        for (int i = 1; i <= amount; i++) {
            for (int coin : coins) {
                if (coin <= i) {
                    dp[i] = Math.min(dp[i], dp[i - coin] + 1);
                }
            }
        }
        return dp[amount] > amount ? -1 : dp[amount];
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String line = sc.nextLine();
        String[] parts = line.substring(1, line.length() - 1).split(",");
        int[] coins = new int[parts.length];
        for (int i = 0; i < parts.length; i++) coins[i] = Integer.parseInt(parts[i].trim());
        int amount = Integer.parseInt(sc.nextLine().trim());
        System.out.println(coinChange(coins, amount));
    }
}`,
    test_cases: [
      { input: '[1,2,5]\n11', expected_output: '3', is_sample: true },
      { input: '[2]\n3', expected_output: '-1', is_sample: true },
      { input: '[1]\n0', expected_output: '0', is_sample: true },
      { input: '[1,5,10,25]\n30', expected_output: '2', is_sample: false },
      { input: '[186,419,83,408]\n6249', expected_output: '20', is_sample: false },
    ]
  },
  {
    title: 'Longest Substring Without Repeating Characters',
    slug: 'longest-substring-without-repeating-characters',
    description: `Given a string \`s\`, find the length of the longest substring without repeating characters.`,
    examples: `**Example 1:**
\`\`\`
Input: s = "abcabcbb"
Output: 3
Explanation: The answer is "abc", with the length of 3.
\`\`\`

**Example 2:**
\`\`\`
Input: s = "bbbbb"
Output: 1
Explanation: The answer is "b", with the length of 1.
\`\`\`

**Example 3:**
\`\`\`
Input: s = "pwwkew"
Output: 3
Explanation: The answer is "wke", with the length of 3.
Notice that the answer must be a substring, "pwke" is a subsequence and not a substring.
\`\`\``,
    constraints: `- \`0 <= s.length <= 5 * 10^4\`
- \`s\` consists of English letters, digits, symbols and spaces.`,
    difficulty: 'medium',
    starter_code_python: `def lengthOfLongestSubstring(s):
    """
    :type s: str
    :rtype: int
    """
    # Your code here
    pass

s = input()
result = lengthOfLongestSubstring(s)
print(result)`,
    starter_code_javascript: `function lengthOfLongestSubstring(s) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = lengthOfLongestSubstring(line);
    console.log(result);
    rl.close();
});`,
    solution_python: `def lengthOfLongestSubstring(s):
    char_set = set()
    left = 0
    max_len = 0
    for right in range(len(s)):
        while s[right] in char_set:
            char_set.remove(s[left])
            left += 1
        char_set.add(s[right])
        max_len = max(max_len, right - left + 1)
    return max_len

s = input()
result = lengthOfLongestSubstring(s)
print(result)`,
    solution_javascript: `function lengthOfLongestSubstring(s) {
    const charSet = new Set();
    let left = 0;
    let maxLen = 0;
    for (let right = 0; right < s.length; right++) {
        while (charSet.has(s[right])) {
            charSet.delete(s[left]);
            left++;
        }
        charSet.add(s[right]);
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = lengthOfLongestSubstring(line);
    console.log(result);
    rl.close();
});`,
    starter_code_cpp: `#include <iostream>
#include <unordered_set>
#include <algorithm>
using namespace std;

int lengthOfLongestSubstring(string s) {
    // Your code here
    return 0;
}

int main() {
    string s;
    getline(cin, s);
    cout << lengthOfLongestSubstring(s) << endl;
    return 0;
}`,
    starter_code_java: `import java.util.*;

public class Solution {
    public static int lengthOfLongestSubstring(String s) {
        // Your code here
        return 0;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.hasNextLine() ? sc.nextLine() : "";
        System.out.println(lengthOfLongestSubstring(s));
    }
}`,
    solution_cpp: `#include <iostream>
#include <unordered_set>
#include <algorithm>
using namespace std;

int lengthOfLongestSubstring(string s) {
    unordered_set<char> charSet;
    int left = 0, maxLen = 0;
    for (int right = 0; right < s.size(); right++) {
        while (charSet.count(s[right])) {
            charSet.erase(s[left++]);
        }
        charSet.insert(s[right]);
        maxLen = max(maxLen, right - left + 1);
    }
    return maxLen;
}

int main() {
    string s;
    getline(cin, s);
    cout << lengthOfLongestSubstring(s) << endl;
    return 0;
}`,
    solution_java: `import java.util.*;

public class Solution {
    public static int lengthOfLongestSubstring(String s) {
        Set<Character> charSet = new HashSet<>();
        int left = 0, maxLen = 0;
        for (int right = 0; right < s.length(); right++) {
            while (charSet.contains(s.charAt(right))) {
                charSet.remove(s.charAt(left++));
            }
            charSet.add(s.charAt(right));
            maxLen = Math.max(maxLen, right - left + 1);
        }
        return maxLen;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.hasNextLine() ? sc.nextLine() : "";
        System.out.println(lengthOfLongestSubstring(s));
    }
}`,
    test_cases: [
      { input: 'abcabcbb', expected_output: '3', is_sample: true },
      { input: 'bbbbb', expected_output: '1', is_sample: true },
      { input: 'pwwkew', expected_output: '3', is_sample: true },
      { input: '', expected_output: '0', is_sample: false },
      { input: 'au', expected_output: '2', is_sample: false },
      { input: 'dvdf', expected_output: '3', is_sample: false },
    ]
  }
];

async function seed(): Promise<void> {
  console.log('Starting seed...');

  try {
    // Create admin user
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    const userPasswordHash = await bcrypt.hash('user123', 10);

    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES
        ($1, 'admin', 'admin@leetcode.local', $2, 'admin'),
        ($3, 'demo', 'demo@leetcode.local', $4, 'user')
      ON CONFLICT (username) DO NOTHING
    `, [uuidv4(), adminPasswordHash, uuidv4(), userPasswordHash]);

    console.log('Created users: admin (password: admin123), demo (password: user123)');

    // Insert problems
    for (const problem of problems) {
      const problemId = uuidv4();

      await pool.query(`
        INSERT INTO problems (id, title, slug, description, examples, constraints, difficulty, starter_code_python, starter_code_javascript, starter_code_cpp, starter_code_java, solution_python, solution_javascript, solution_cpp, solution_java)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          examples = EXCLUDED.examples,
          constraints = EXCLUDED.constraints,
          difficulty = EXCLUDED.difficulty,
          starter_code_python = EXCLUDED.starter_code_python,
          starter_code_javascript = EXCLUDED.starter_code_javascript,
          starter_code_cpp = EXCLUDED.starter_code_cpp,
          starter_code_java = EXCLUDED.starter_code_java,
          solution_python = EXCLUDED.solution_python,
          solution_javascript = EXCLUDED.solution_javascript,
          solution_cpp = EXCLUDED.solution_cpp,
          solution_java = EXCLUDED.solution_java,
          updated_at = NOW()
        RETURNING id
      `, [
        problemId,
        problem.title,
        problem.slug,
        problem.description,
        problem.examples,
        problem.constraints,
        problem.difficulty,
        problem.starter_code_python,
        problem.starter_code_javascript,
        problem.starter_code_cpp,
        problem.starter_code_java,
        problem.solution_python,
        problem.solution_javascript,
        problem.solution_cpp,
        problem.solution_java
      ]);

      // Get the actual problem ID (in case of update)
      const { rows } = await pool.query('SELECT id FROM problems WHERE slug = $1', [problem.slug]);
      const actualProblemId = rows[0].id;

      // Delete existing test cases for this problem
      await pool.query('DELETE FROM test_cases WHERE problem_id = $1', [actualProblemId]);

      // Insert test cases
      for (let i = 0; i < problem.test_cases.length; i++) {
        const tc = problem.test_cases[i];
        await pool.query(`
          INSERT INTO test_cases (id, problem_id, input, expected_output, is_sample, order_index)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [uuidv4(), actualProblemId, tc.input, tc.expected_output, tc.is_sample, i]);
      }

      console.log(`Created problem: ${problem.title} with ${problem.test_cases.length} test cases`);
    }

    console.log('Seed completed successfully!');
  } catch (error) {
    console.error('Seed error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed().catch(console.error);
